// Long-lived shell output is decoded into a byte-bounded queue here. Effect owns spawn,
// streams, forced cleanup, and scope lifetime; immediate graceful signal dispatch, the
// POSIX post-leader process-group sweep, and Windows taskkill run through core's
// process-tree helpers under this boundary's graceful/force policy.
import { StringDecoder } from "node:string_decoder";
import {
  effectProcessExit,
  nodeProcessLayer,
  signalProcess,
  signalProcessGroup,
  terminateWindowsProcessTree,
  type ProcessTreeTerminatorSpawn,
} from "pi-cosmic-core";
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
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { BackgroundLogStream } from "../task/model.ts";
import { utf8ByteLength, utf8Tail } from "../task/utf8.ts";

const nodeFsModule = process.getBuiltinModule("node:fs");
if (!nodeFsModule) throw new Error("Node fs builtin is unavailable.");
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

/** Redacted boundary failures: never the command, its output, or the underlying error text. */
const PROCESS_FAILURES = {
  cwd: { operation: "inspect working directory", message: "Couldn't find the working directory" },
  spawn: { operation: "spawn", message: "Couldn't start the process" },
  terminate: { operation: "terminate", message: "Couldn't stop the process" },
} as const satisfies Record<
  LocalProcessError["reason"],
  { readonly operation: string; readonly message: string }
>;

const processError = (reason: LocalProcessError["reason"], subject?: string) =>
  new LocalProcessError({
    reason,
    operation: PROCESS_FAILURES[reason].operation,
    message: subject
      ? `${PROCESS_FAILURES[reason].message} ${subject}`
      : PROCESS_FAILURES[reason].message,
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

// Exit and termination can race; final settlement is observed separately.
const dispatchGracefulTermination = (pid: number) => {
  if (signalProcessGroup(pid, "SIGTERM") !== "present") signalProcess(pid, "SIGTERM");
};

/** Immediate graceful dispatch is owned by the process scope, not its stop waiter. */
export const makeWindowsTreeTermination = (
  pid: number,
  spawnTaskkill?: ProcessTreeTerminatorSpawn,
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Effect.scope;
    // Every core terminator failure maps to the same redacted boundary error.
    const taskkill = (mode: "graceful" | "force") =>
      terminateWindowsProcessTree({ pid, mode, spawnTaskkill }).pipe(
        Effect.mapError(() => processError("terminate")),
      );
    let gracefulFiber: Fiber.Fiber<void> | undefined;
    let dispatched = false;
    const forceLock = yield* Semaphore.make(1);
    // Once force owns the permit, join graceful cleanup and the bounded force attempt.
    // The mask can delay cancellation by at most the helper's two-second deadline.
    const force = forceLock.withPermits(1)(
      Effect.suspend(() => {
        dispatched = true;
        return (gracefulFiber ? Fiber.interrupt(gracefulFiber) : Effect.void).pipe(
          Effect.andThen(taskkill("force")),
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
              gracefulFiber = yield* taskkill("graceful").pipe(
                Effect.ignore,
                Effect.forkIn(ownerScope, { startImmediately: true }),
              );
            }),
          );
  });

// A group-free normal exit is the common case, so the sweep result is ignored.
const terminateLingeringGroup = (pid: number) =>
  Effect.sync(() => void signalProcessGroup(pid, "SIGKILL"));

const verifyCwd = (
  cwd: string,
  inspect: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
) =>
  Effect.tryPromise({
    try: () => inspect(cwd),
    catch: () => processError("cwd", cwd),
  }).pipe(
    Effect.flatMap((info) =>
      info.isDirectory()
        ? Effect.void
        : Effect.fail(
            new LocalProcessError({
              operation: PROCESS_FAILURES.cwd.operation,
              reason: "cwd",
              message: `The working directory is not a directory: ${cwd}`,
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
  const child = yield* spawner.spawn(command).pipe(Effect.mapError(() => processError("spawn")));
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
        Effect.orElseSucceed(() => true),
        Effect.flatMap((running) =>
          running
            ? child.kill({ killSignal: "SIGKILL" }).pipe(
                Effect.timeoutOrElse({
                  duration: "2 seconds",
                  orElse: () => Effect.fail(processError("terminate")),
                }),
              )
            : terminateLingeringGroup(pid),
        ),
        Effect.mapError((error) =>
          error instanceof LocalProcessError ? error : processError("terminate"),
        ),
      );
  const terminate = (mode: "graceful" | "force") =>
    mode === "force"
      ? forceTermination
      : windowsTermination
        ? windowsTermination("graceful")
        : Effect.sync(() => dispatchGracefulTermination(pid));

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
