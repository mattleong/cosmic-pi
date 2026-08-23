import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

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
  readonly dispatched: boolean;
}

interface OutputCollector {
  readonly chunks: Array<Uint8Array>;
  size: number;
}

interface TotalOutputCounter {
  readonly maximumBytes: number;
  size: number;
}

const boundedOutput = (
  streamName: "stdout" | "stderr",
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maximumBytes: number,
  collector: OutputCollector,
  total: TotalOutputCounter,
) =>
  stream.pipe(
    Stream.runForEach((chunk) =>
      Effect.suspend(() => {
        const remaining = Math.max(
          0,
          Math.min(maximumBytes - collector.size, total.maximumBytes - total.size),
        );
        if (remaining > 0) {
          const retained = chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
          collector.chunks.push(retained);
          collector.size += retained.byteLength;
          total.size += retained.byteLength;
        }
        return chunk.byteLength > remaining
          ? Effect.fail(new BoundedProcessOverflow({ stream: streamName }))
          : Effect.void;
      }),
    ),
  );

export interface EffectProcessExit {
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
  // Pinned rc.111 exposes the signal only through this stable nested cause text.
  return { code: null, signal: /receipt of signal: '([^']+)'/u.exec(message)?.[1] ?? null };
};

const decodeOutput = (collector: OutputCollector): string => {
  const bytes = new Uint8Array(collector.size);
  let offset = 0;
  for (const chunk of collector.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const sweepExitedProcessTree = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timeoutMillis: number,
): Effect.Effect<boolean> => {
  if (process.platform !== "win32")
    return Effect.try({
      try: () => {
        process.kill(-Number(handle.pid), "SIGKILL");
        return true;
      },
      catch: (error) =>
        Predicate.hasProperty(error, "code") && error.code === "ESRCH"
          ? ("absent" as const)
          : ("failed" as const),
    }).pipe(
      Effect.match({
        onFailure: (outcome) => outcome === "absent",
        onSuccess: () => true,
      }),
    );
  return handle.kill({ killSignal: "SIGKILL" }).pipe(
    Effect.timeoutOption(Math.max(1, timeoutMillis)),
    Effect.map(Option.isSome),
    // The leader has already exited. Match the previous Windows adapter, which
    // treats a non-zero taskkill result as settled in that state.
    Effect.catch(() => Effect.succeed(true)),
  );
};

/** Kill a scoped Effect child and bound confirmation of its exit. */
export const confirmEffectProcessClose = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timeoutMillis: number,
): Effect.Effect<boolean> =>
  Effect.interruptible(
    handle.isRunning.pipe(
      Effect.catch(() => Effect.succeed(true)),
      Effect.flatMap((running) =>
        running
          ? handle
              .kill({ killSignal: "SIGTERM", forceKillAfter: Math.max(1, timeoutMillis / 2) })
              .pipe(
                Effect.timeoutOption(Math.max(1, timeoutMillis)),
                Effect.map(Option.isSome),
                Effect.catch(() => Effect.succeed(false)),
              )
          : Effect.succeed(true),
      ),
    ),
  );

/**
 * Runs a bounded one-shot process under Effect scope ownership. Output overflow
 * and deadlines terminate the process before returning their structured result.
 */
export const runBoundedProcess = Effect.fn("BoundedProcess.run")(function* (
  request: BoundedProcessRequest,
) {
  const stdout: OutputCollector = { chunks: [], size: 0 };
  const stderr: OutputCollector = { chunks: [], size: 0 };
  const totalOutput: TotalOutputCounter = {
    maximumBytes: Math.max(
      0,
      request.totalOutputLimitBytes ?? request.stdoutLimitBytes + request.stderrLimitBytes,
    ),
    size: 0,
  };
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
  const handle = yield* command.pipe(
    Effect.mapError(
      () => new BoundedProcessError({ operation: "spawn", message: "Unable to start process." }),
    ),
  );
  const observed = Effect.all(
    [
      boundedOutput(
        "stdout",
        handle.stdout,
        Math.max(0, request.stdoutLimitBytes),
        stdout,
        totalOutput,
      ),
      boundedOutput(
        "stderr",
        handle.stderr,
        Math.max(0, request.stderrLimitBytes),
        stderr,
        totalOutput,
      ),
      Effect.exit(handle.exitCode),
    ] as const,
    { concurrency: 3 },
  ).pipe(
    Effect.map(([, , exit]) => ({ _tag: "Completed" as const, exit })),
    Effect.catch((error) =>
      error instanceof BoundedProcessOverflow
        ? Effect.succeed({ _tag: "Overflow" as const })
        : Effect.fail(
            new BoundedProcessError({
              operation: "stream",
              message: "Unable to read process output.",
            }),
          ),
    ),
  );
  const outcome = yield* Effect.raceFirst(
    observed,
    Effect.sleep(Math.max(1, request.timeoutMillis)).pipe(Effect.as({ _tag: "Timeout" as const })),
  );
  if (outcome._tag === "Completed") {
    const cleanupConfirmed = request.sweepProcessTreeOnExit
      ? yield* sweepExitedProcessTree(handle, cleanupTimeoutMillis)
      : true;
    const processExit = effectProcessExit(outcome.exit);
    return {
      code: processExit.code,
      signal: processExit.signal,
      stdout: decodeOutput(stdout),
      stderr: decodeOutput(stderr),
      overflowed: false,
      timedOut: false,
      cleanupUnconfirmed: !cleanupConfirmed,
      dispatched: true,
    } satisfies BoundedProcessResult;
  }

  const cleanupConfirmed = yield* confirmEffectProcessClose(handle, cleanupTimeoutMillis);
  return {
    code: null,
    signal: null,
    stdout: decodeOutput(stdout),
    stderr: decodeOutput(stderr),
    overflowed: outcome._tag === "Overflow",
    timedOut: outcome._tag === "Timeout",
    cleanupUnconfirmed: !cleanupConfirmed,
    dispatched: true,
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
const provideLayer = Effect.provide;
export const provideNodeProcess = provideLayer(nodeProcessLayer);

export const runBoundedProcessNode = (
  request: BoundedProcessRequest,
): Effect.Effect<BoundedProcessResult, BoundedProcessError> =>
  runBoundedProcessScoped(request).pipe(provideNodeProcess);
