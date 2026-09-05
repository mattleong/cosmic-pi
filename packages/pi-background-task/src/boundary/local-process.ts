// Long-lived shell output is decoded into a byte-bounded queue here. Effect owns spawn,
// streams, forced cleanup, and scope lifetime; immediate graceful signal dispatch, the
// POSIX post-leader process-group sweep, and the bounded Windows taskkill tree terminator
// remain raw platform operations.
import { StringDecoder } from "node:string_decoder";
import { effectProcessExit, nodeProcessLayer } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { BackgroundLogStream } from "../task/model.ts";
import { utf8ByteLength, utf8Tail } from "../task/utf8.ts";

const childProcessModule = process.getBuiltinModule("node:child_process");
const nodeFsModule = process.getBuiltinModule("node:fs");
if (!childProcessModule || !nodeFsModule) {
  throw new Error("Node child_process/fs builtins are unavailable.");
}
const { spawn: spawnWindowsTreeTerminator } = childProcessModule;
const { stat } = nodeFsModule.promises;

const INGRESS_CHUNKS = 32;
const BLOCKED_ENVIRONMENT_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
]);

export interface LocalProcessRequest {
  readonly command: string;
  readonly cwd: string;
  readonly shellPath?: string;
  readonly ingressBufferBytes: number;
}

export interface LocalProcessOutput {
  readonly stream: BackgroundLogStream;
  readonly text: string;
  readonly droppedBytes: number;
}

export interface LocalProcessExit {
  readonly exitCode: number | null;
  readonly signal?: string;
}

export interface LocalProcessHandle {
  readonly pid: number;
  readonly output: Stream.Stream<LocalProcessOutput>;
  readonly awaitExit: Effect.Effect<LocalProcessExit>;
  readonly droppedOutputBytes: () => number;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, LocalProcessError>;
}

export class LocalProcessError extends Schema.TaggedError<LocalProcessError>()(
  "LocalProcessError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["cwd", "spawn", "terminate"]),
    message: Schema.String,
  },
) {}

export interface LocalProcessContract {
  readonly spawn: (
    request: LocalProcessRequest,
  ) => Effect.Effect<LocalProcessHandle, LocalProcessError, Scope.Scope>;
}

const processError = <ErrorInput>(operation: string, _error: ErrorInput) =>
  new LocalProcessError({
    operation,
    reason:
      operation === "inspect working directory"
        ? "cwd"
        : operation === "spawn"
          ? "spawn"
          : "terminate",
    message: `Unable to ${operation} local process.`,
  });

export function makeBackgroundProcessEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) =>
        value !== undefined &&
        !BLOCKED_ENVIRONMENT_KEYS.has(platform === "win32" ? key.toUpperCase() : key),
    ),
  );
  // Background stdout/stderr are pipes, so compatible CLIs otherwise suppress useful color.
  // Explicit FORCE_COLOR and the cross-ecosystem NO_COLOR convention always win. Windows
  // environment keys are case-insensitive even though the reconstructed plain object is not.
  const hasKey = (name: string): boolean =>
    platform === "win32"
      ? Object.keys(environment).some((key) => key.toUpperCase() === name)
      : environment[name] !== undefined;
  if (!hasKey("FORCE_COLOR") && !hasKey("NO_COLOR")) environment.FORCE_COLOR = "1";
  return environment;
}

function dispatchGracefulTermination(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Exit and termination can race; final settlement is observed separately.
    }
  }
}

export interface WindowsTreeTerminatorChild {
  on(event: "exit" | "error", listener: (result: Error | number | null) => void): void;
  removeListener(event: "exit" | "error", listener: (result: Error | number | null) => void): void;
  kill(signal: NodeJS.Signals): void;
  unref(): void;
}

export type WindowsTreeTerminatorSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly stdio: "ignore"; readonly windowsHide: true },
) => WindowsTreeTerminatorChild;

/**
 * Windows lacks POSIX process groups, so `taskkill /pid PID /T /F` is the whole-tree force
 * terminator. It runs through a raw bounded callback rather than a scoped Effect spawner
 * because interruption cleanup (typically the 2-second timeout) must stay synchronous:
 * remove the settle listeners, install a harmless late-error listener, SIGKILL the
 * terminator, and unref it without ever awaiting taskkill's own exit, so a hung taskkill
 * cannot hang the interrupting finalizer join.
 */
export const terminateWindowsTree = (
  pid: number,
  spawnTerminator: WindowsTreeTerminatorSpawn = spawnWindowsTreeTerminator,
  mode: "graceful" | "force" = "force",
): Effect.Effect<void, LocalProcessError> =>
  Effect.callback<void, LocalProcessError>((resume) => {
    let killer: WindowsTreeTerminatorChild;
    try {
      killer = spawnTerminator(
        "taskkill",
        ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
    } catch (error) {
      resume(Effect.fail(processError("terminate", error)));
      return Effect.void;
    }
    // Keep acquisition and listener/finalizer handoff in this synchronous callback.
    // A throwing cleanup method must not suppress the remaining cleanup attempts.
    const attempt = (operation: () => void): boolean => {
      try {
        operation();
        return true;
      } catch {
        return false;
      }
    };
    let settled = false;
    let cleaned = false;
    const removeListeners = () => {
      const exitRemoved = attempt(() => killer.removeListener("exit", settle));
      const errorRemoved = attempt(() => killer.removeListener("error", settle));
      return exitRemoved && errorRemoved;
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      settled = true;
      removeListeners();
      attempt(() => killer.on("error", () => {}));
      attempt(() => killer.kill("SIGKILL"));
      attempt(() => killer.unref());
    };
    const settle = (result: Error | number | null) => {
      if (settled) return;
      settled = true;
      const detached = removeListeners();
      if (!detached) cleanup();
      resume(
        result === 0 && detached ? Effect.void : Effect.fail(processError("terminate", result)),
      );
    };
    try {
      killer.on("exit", settle);
      killer.on("error", settle);
    } catch (error) {
      cleanup();
      resume(Effect.fail(processError("terminate", error)));
    }
    return Effect.sync(cleanup);
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(processError("terminate", "taskkill timed out")),
    }),
  );

/** Immediate graceful dispatch is owned by the process scope, not its stop waiter. */
export const makeWindowsTreeTermination = (
  pid: number,
  spawn: WindowsTreeTerminatorSpawn = spawnWindowsTreeTerminator,
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Effect.scope;
    let gracefulFiber: Fiber.Fiber<void> | undefined;
    let dispatched = false;
    const forceLock = yield* Semaphore.make(1);
    // Once force owns the permit, join graceful cleanup and the bounded force attempt.
    // The mask can delay cancellation by at most the helper's two-second deadline.
    const force = forceLock.withPermits(1)(
      Effect.suspend(() => {
        dispatched = true;
        return (gracefulFiber ? Fiber.interrupt(gracefulFiber) : Effect.void).pipe(
          Effect.andThen(terminateWindowsTree(pid, spawn)),
        );
      }).pipe(Effect.uninterruptible),
    );
    return (mode: "graceful" | "force") =>
      mode === "force"
        ? force
        : Effect.uninterruptible(
            Effect.gen(function* () {
              if (dispatched) return;
              dispatched = true;
              gracefulFiber = yield* terminateWindowsTree(pid, spawn, "graceful").pipe(
                Effect.ignore,
                Effect.forkIn(ownerScope, { startImmediately: true }),
              );
            }),
          );
  });

const terminateLingeringGroup = (pid: number): Effect.Effect<void> => {
  if (process.platform === "win32") return terminateWindowsTree(pid).pipe(Effect.ignore);
  return Effect.sync(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // A group-free normal exit is the common case.
    }
  });
};

const verifyCwd = (
  cwd: string,
  inspect: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
) =>
  Effect.tryPromise({
    try: () => inspect(cwd),
    catch: (error) => processError("inspect working directory", error),
  }).pipe(
    Effect.flatMap((info) =>
      info.isDirectory()
        ? Effect.void
        : Effect.fail(
            new LocalProcessError({
              operation: "inspect working directory",
              reason: "cwd",
              message: `Working directory is not a directory: ${cwd}`,
            }),
          ),
    ),
  );

const acquireProcess = Effect.fn("LocalProcess.acquire")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: LocalProcessRequest,
) {
  const ingressBufferBytes = Math.max(1, Math.floor(request.ingressBufferBytes));
  const outputQueue = yield* Queue.dropping<LocalProcessOutput, Cause.Done>(INGRESS_CHUNKS);
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let queuedBytes = 0;
  let totalDroppedBytes = 0;
  let reportedDroppedBytes = 0;
  let outputClosed = false;

  const command = ChildProcess.make(request.command, [], {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    env: makeBackgroundProcessEnvironment(process.env),
    extendEnv: false,
    shell: request.shellPath ?? true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    killSignal: "SIGTERM",
    forceKillAfter: 1_000,
  });
  const child = yield* spawner
    .spawn(command)
    .pipe(Effect.mapError((error) => processError("spawn", error)));
  const pid = Number(child.pid);
  const windowsTermination =
    process.platform === "win32" ? yield* makeWindowsTreeTermination(pid) : undefined;

  const offer = (stream: BackgroundLogStream, original: string) => {
    if (!original || outputClosed) return;
    const tail = utf8Tail(original, ingressBufferBytes);
    totalDroppedBytes += utf8ByteLength(original) - tail.bytes;
    if (!tail.text) return;

    // Make room by bytes and count. Eviction also restores any dropped-byte delta carried
    // only by the removed event so a later event reports it.
    while (Queue.isFullUnsafe(outputQueue) || queuedBytes + tail.bytes > ingressBufferBytes) {
      const evicted = Queue.takeUnsafe(outputQueue);
      if (evicted?._tag !== "Success") break;
      const evictedBytes = utf8ByteLength(evicted.value.text);
      queuedBytes = Math.max(0, queuedBytes - evictedBytes);
      totalDroppedBytes += evictedBytes;
      reportedDroppedBytes = Math.max(0, reportedDroppedBytes - evicted.value.droppedBytes);
    }
    if (Queue.isFullUnsafe(outputQueue) || queuedBytes + tail.bytes > ingressBufferBytes) {
      totalDroppedBytes += tail.bytes;
      return;
    }
    const event = {
      stream,
      text: tail.text,
      droppedBytes: totalDroppedBytes - reportedDroppedBytes,
    } satisfies LocalProcessOutput;
    if (Queue.offerUnsafe(outputQueue, event)) {
      queuedBytes += tail.bytes;
      reportedDroppedBytes = totalDroppedBytes;
    } else {
      totalDroppedBytes += tail.bytes;
    }
  };
  const closeOutput = () => {
    if (outputClosed) return;
    offer("stdout", stdoutDecoder.end());
    offer("stderr", stderrDecoder.end());
    outputClosed = true;
    Queue.endUnsafe(outputQueue);
  };
  const observe = (
    stream: "stdout" | "stderr",
    decoder: StringDecoder,
    source: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ) =>
    source.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => offer(stream, decoder.write(Buffer.from(chunk)))),
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          offer("stderr", `\nLocal process ${stream} stream failed.\n`);
        }),
      ),
    );

  yield* Effect.all(
    [
      observe("stdout", stdoutDecoder, child.stdout),
      observe("stderr", stderrDecoder, child.stderr),
    ],
    { concurrency: 2, discard: true },
  ).pipe(Effect.ensuring(Effect.sync(closeOutput)), Effect.forkScoped({ startImmediately: true }));
  const exitFiber = yield* Effect.exit(child.exitCode).pipe(
    Effect.flatMap((exit) => {
      const observed = effectProcessExit(exit);
      const result = {
        exitCode: observed.code,
        ...(observed.signal && { signal: observed.signal }),
      };
      return (
        windowsTermination
          ? windowsTermination("force").pipe(Effect.ignore)
          : terminateLingeringGroup(pid)
      ).pipe(Effect.as(result));
    }),
    Effect.forkScoped({ startImmediately: true }),
  );

  const forceTermination = windowsTermination
    ? windowsTermination("force")
    : child.isRunning.pipe(
        Effect.catch(() => Effect.succeed(true)),
        Effect.flatMap((running) =>
          running
            ? child.kill({ killSignal: "SIGKILL" }).pipe(
                Effect.timeoutOrElse({
                  duration: "2 seconds",
                  orElse: () => Effect.fail(processError("terminate", "cleanup timed out")),
                }),
              )
            : terminateLingeringGroup(pid),
        ),
        Effect.mapError((error) =>
          error instanceof LocalProcessError ? error : processError("terminate", error),
        ),
      );
  const terminate = (mode: "graceful" | "force") =>
    mode === "force"
      ? forceTermination
      : windowsTermination
        ? windowsTermination("graceful")
        : Effect.try({
            try: () => dispatchGracefulTermination(pid),
            catch: (error) => processError("terminate", error),
          });

  const output = Stream.fromQueue(outputQueue).pipe(
    Stream.mapEffect((event) =>
      Effect.sync(() => {
        queuedBytes = Math.max(0, queuedBytes - utf8ByteLength(event.text));
        return event;
      }),
    ),
  );

  return {
    pid,
    output,
    awaitExit: Fiber.join(exitFiber),
    droppedOutputBytes: () => totalDroppedBytes,
    terminate,
    release: child.unref.pipe(
      Effect.andThen(terminate("force")),
      Effect.timeoutOrElse({ duration: "2500 millis", orElse: () => Effect.void }),
      Effect.ignore,
      Effect.ensuring(Effect.sync(closeOutput)),
    ),
  };
});

export class LocalProcess extends Context.Service<LocalProcess, LocalProcessContract>()(
  "pi-background-task/boundary/local-process/LocalProcess",
) {
  /** Owned filesystem inspection seam; production supplies Node stat. */
  static readonly layerWithInspection = (
    inspect: (path: string) => Promise<{ isDirectory(): boolean }>,
  ) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return LocalProcess.of({
          // Inspection owns no resource. Do not mask a noncooperative filesystem Promise.
          spawn: (request) =>
            verifyCwd(request.cwd, inspect).pipe(
              Effect.andThen(
                Effect.acquireRelease(acquireProcess(spawner, request), (handle) => handle.release),
              ),
              Effect.map(({ release: _release, ...handle }) => handle),
            ),
        });
      }),
    ).pipe(Layer.provide(nodeProcessLayer));

  static readonly layer = this.layerWithInspection(stat);
}
