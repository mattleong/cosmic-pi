import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { signalProcessGroup } from "./process-tree.ts";

/** Opt-in process authority. It is intentionally excluded from nodeFilePlatformLayer. */
export const nodeProcessLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);

export class BoundedProcessError extends Schema.TaggedError<BoundedProcessError>()(
  "BoundedProcessError",
  {
    operation: Schema.Literals(["spawn", "stream"]),
    message: Schema.String,
  },
) {}

class BoundedProcessOverflow extends Schema.TaggedError<BoundedProcessOverflow>()(
  "BoundedProcessOverflow",
  { stream: Schema.Literals(["stdout", "stderr"]) },
) {}

export interface BoundedProcessRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: Uint8Array;
  readonly stdoutLimitBytes: number;
  readonly stderrLimitBytes: number;
  readonly totalOutputLimitBytes?: number;
  readonly timeoutMillis: number;
  readonly cleanupTimeoutMillis?: number;
  /** Total, synchronous observer called during finalization, including interruption.
   * False also covers failed acquisition: no handle means no proof of cleanup.
   */
  readonly onCleanup?: (confirmed: boolean) => void;
  /** Sweep a detached process group even after a successful leader exit. */
  readonly sweepProcessTreeOnExit?: boolean;
  readonly detached?: boolean;
  readonly windowsHide?: boolean;
}

export interface BoundedProcessResult {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflowed: boolean;
  readonly timedOut: boolean;
  readonly cleanupUnconfirmed: boolean;
}

/** Retains one stream within its own and the shared total budget; any excess is an overflow. */
const boundedOutput = (
  source: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  streamName: "stdout" | "stderr",
  maximumBytes: number,
  total: { readonly maximumBytes: number; size: number },
) => {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  const drain = source.pipe(
    Stream.runForEach((chunk) =>
      Effect.suspend(() => {
        const remaining = Math.max(
          0,
          Math.min(maximumBytes - size, total.maximumBytes - total.size),
        );
        if (remaining > 0) {
          const retained = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
          chunks.push(retained);
          size += retained.byteLength;
          total.size += retained.byteLength;
        }
        return chunk.byteLength > remaining
          ? Effect.fail(new BoundedProcessOverflow({ stream: streamName }))
          : Effect.void;
      }),
    ),
  );
  return { drain, text: () => new TextDecoder().decode(Buffer.concat(chunks)) };
};

interface EffectProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

/** Decodes the public Effect child-process exit channel without leaking PlatformError. */
export const effectProcessExit = (
  exit: Exit.Exit<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
): EffectProcessExit => {
  if (Exit.isSuccess(exit)) return { code: Number(exit.value), signal: null };
  const failure = Cause.squash(exit.cause);
  const source =
    failure instanceof PlatformError.PlatformError && "cause" in failure.reason
      ? failure.reason.cause
      : failure;
  const message = source instanceof Error ? source.message : String(source);
  // Pinned Effect 4.0.0 exposes the signal only through this stable nested cause text.
  return { code: null, signal: /receipt of signal: '([^']+)'/u.exec(message)?.[1] ?? null };
};

const sweepExitedProcessTree = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timeoutMillis: number,
): Effect.Effect<boolean> => {
  if (process.platform !== "win32")
    return Effect.sync(() => {
      const group = signalProcessGroup(Number(handle.pid), "SIGKILL");
      return group === "present" || group === "absent";
    });
  return handle.kill({ killSignal: "SIGKILL" }).pipe(
    Effect.timeoutOption(Math.max(1, timeoutMillis)),
    Effect.map(Option.isSome),
    // The leader has already exited. Match the previous Windows adapter, which
    // treats a non-zero taskkill result as settled in that state.
    Effect.orElseSucceed(() => true),
  );
};

/** Kill a scoped Effect child and bound confirmation of its exit. */
export const confirmEffectProcessClose = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timeoutMillis: number,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const running = yield* handle.isRunning;
    if (!running) return true;
    yield* handle
      .kill({ killSignal: "SIGTERM", forceKillAfter: Math.max(1, timeoutMillis / 2) })
      .pipe(Effect.ignore);
    // Successful signal delivery is not proof of exit. Pinned Node uses its
    // exit-event Deferred for isRunning, including signal-terminated children.
    return !(yield* handle.isRunning);
  }).pipe(
    Effect.interruptible,
    Effect.timeoutOption(Math.max(1, timeoutMillis)),
    Effect.map((result) => Option.isSome(result) && result.value),
    Effect.catchCause(() => Effect.succeed(false)),
  );

/**
 * Runs a bounded one-shot process under Effect scope ownership. Output overflow
 * and deadlines terminate the process before returning their structured result.
 */
const runBoundedProcess = Effect.fn("BoundedProcess.run")(function* (
  request: BoundedProcessRequest,
) {
  const cleanupTimeoutMillis = Math.max(1, request.cleanupTimeoutMillis ?? 2_000);
  const command = ChildProcess.make(request.executable, [...request.args], {
    cwd: request.cwd,
    env: request.environment ? { ...request.environment } : undefined,
    extendEnv: false,
    detached: request.detached,
    windowsHide: request.windowsHide,
    stdin: request.stdin ? Stream.make(request.stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: Math.max(1, cleanupTimeoutMillis / 2),
  });
  const handle = yield* Effect.uninterruptible(
    Effect.gen(function* () {
      // Register before dispatch. The spawner can acquire a native child and
      // fail before publishing its handle; its own finalizer swallows kill errors.
      let confirmed = false;
      if (request.onCleanup)
        yield* Effect.addFinalizer(() => Effect.sync(() => request.onCleanup!(confirmed)));
      const acquired = yield* command.pipe(
        Effect.mapError(
          () =>
            new BoundedProcessError({ operation: "spawn", message: "Unable to start process." }),
        ),
      );
      if (request.onCleanup)
        yield* Effect.addFinalizer(() =>
          confirmEffectProcessClose(acquired, cleanupTimeoutMillis).pipe(
            Effect.flatMap((closed) =>
              closed && request.sweepProcessTreeOnExit
                ? sweepExitedProcessTree(acquired, cleanupTimeoutMillis)
                : Effect.succeed(closed),
            ),
            Effect.tap((closed) =>
              Effect.sync(() => {
                confirmed = closed;
              }),
            ),
          ),
        );
      return acquired;
    }),
  );
  const total = {
    maximumBytes: Math.max(
      0,
      request.totalOutputLimitBytes ?? request.stdoutLimitBytes + request.stderrLimitBytes,
    ),
    size: 0,
  };
  const stdout = boundedOutput(handle.stdout, "stdout", request.stdoutLimitBytes, total);
  const stderr = boundedOutput(handle.stderr, "stderr", request.stderrLimitBytes, total);
  const observed = Effect.all([stdout.drain, stderr.drain, Effect.exit(handle.exitCode)] as const, {
    concurrency: 3,
  }).pipe(
    Effect.map(([, , exit]) => ({ _tag: "Completed" as const, exit })),
    Effect.catchTag("BoundedProcessOverflow", () => Effect.succeed({ _tag: "Overflow" as const })),
    Effect.mapError(
      () =>
        new BoundedProcessError({ operation: "stream", message: "Unable to read process output." }),
    ),
  );
  const outcome = yield* observed.pipe(
    Effect.timeoutOrElse({
      duration: Math.max(1, request.timeoutMillis),
      orElse: () => Effect.succeed({ _tag: "Timeout" as const }),
    }),
  );
  const cleanupConfirmed =
    outcome._tag === "Completed"
      ? request.sweepProcessTreeOnExit
        ? yield* sweepExitedProcessTree(handle, cleanupTimeoutMillis)
        : true
      : yield* confirmEffectProcessClose(handle, cleanupTimeoutMillis);
  return {
    ...(outcome._tag === "Completed"
      ? effectProcessExit(outcome.exit)
      : { code: null, signal: null }),
    stdout: stdout.text(),
    stderr: stderr.text(),
    overflowed: outcome._tag === "Overflow",
    timedOut: outcome._tag === "Timeout",
    cleanupUnconfirmed: !cleanupConfirmed,
  } satisfies BoundedProcessResult;
});

export const runBoundedProcessScoped = (
  request: BoundedProcessRequest,
): Effect.Effect<
  BoundedProcessResult,
  BoundedProcessError,
  ChildProcessSpawner.ChildProcessSpawner
> => Effect.scoped(runBoundedProcess(request));

/** Named Node boundary for consumers that do not own a larger platform Layer. */
export const provideNodeProcess = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, ChildProcessSpawner.ChildProcessSpawner>> =>
  Effect.scoped(
    Effect.flatMap(Layer.build(nodeProcessLayer), (services) => Effect.provide(effect, services)),
  );

export const runBoundedProcessNode = (
  request: BoundedProcessRequest,
): Effect.Effect<BoundedProcessResult, BoundedProcessError> =>
  runBoundedProcessScoped(request).pipe(provideNodeProcess);
