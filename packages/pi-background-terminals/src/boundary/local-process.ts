// Long-lived shell output is decoded into a byte-bounded queue here. Effect owns spawn,
// streams, forced cleanup, and scope lifetime; only immediate signal dispatch and the
// post-leader process-group sweep remain raw platform operations.
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
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { BackgroundLogStream } from "../job/model.ts";
import { utf8ByteLength, utf8Tail } from "../job/utf8.ts";

const childProcessModule = process.getBuiltinModule("node:child_process");
const nodeFsModule = process.getBuiltinModule("node:fs");
if (!childProcessModule || !nodeFsModule) {
  throw new Error("Node child_process/fs builtins are unavailable.");
}
const { spawn: spawnWindowsTreeTerminator } = childProcessModule;
const { stat } = nodeFsModule.promises;

const INGRESS_CHUNKS = 32;
const BLOCKED_ENVIRONMENT_KEYS = new Set(["BASH_ENV", "ENV", "NODE_OPTIONS", "NODE_PATH"]);

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
  readonly error?: string;
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
  { operation: Schema.String, message: Schema.String },
) {}

export interface LocalProcessContract {
  readonly spawn: (
    request: LocalProcessRequest,
  ) => Effect.Effect<LocalProcessHandle, LocalProcessError, Scope.Scope>;
}

const processError = <ErrorInput>(operation: string, _error: ErrorInput) =>
  new LocalProcessError({
    operation,
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
        !BLOCKED_ENVIRONMENT_KEYS.has(key) &&
        key !== "PI_SESSION_FILE" &&
        key !== "PI_SESSION_ID",
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
  if (process.platform === "win32") {
    const killer = spawnWindowsTreeTerminator("taskkill", ["/pid", String(pid), "/T"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {});
    killer.unref();
    return;
  }
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

const terminateWindowsTree = (
  pid: number,
  mode: "graceful" | "force",
): Effect.Effect<void, LocalProcessError> =>
  Effect.callback<void, LocalProcessError>((resume) => {
    let killer: ReturnType<typeof spawnWindowsTreeTerminator>;
    try {
      killer = spawnWindowsTreeTerminator(
        "taskkill",
        ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])],
        { stdio: "ignore", windowsHide: true },
      );
    } catch (error) {
      resume(Effect.fail(processError("terminate", error)));
      return Effect.void;
    }
    let settled = false;
    const cleanup = () => {
      killer.off("error", onError);
      killer.off("close", onClose);
    };
    const finish = (effect: Effect.Effect<void, LocalProcessError>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resume(effect);
    };
    const onError = (error: Error) => finish(Effect.fail(processError("terminate", error)));
    const onClose = (code: number | null) =>
      finish(
        code === 0
          ? Effect.void
          : Effect.fail(processError("terminate", "taskkill did not confirm cleanup")),
      );
    killer.once("error", onError);
    killer.once("close", onClose);
    return Effect.sync(() => {
      cleanup();
      if (!settled) killer.kill("SIGKILL");
    });
  }).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.flatMap((outcome) =>
      outcome._tag === "Some"
        ? Effect.void
        : Effect.fail(processError("terminate", "taskkill timed out")),
    ),
  );

const terminateLingeringGroup = (pid: number): Effect.Effect<void> => {
  if (process.platform === "win32")
    return terminateWindowsTree(pid, "force").pipe(Effect.catch(() => Effect.void));
  return Effect.sync(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // A group-free normal exit is the common case.
    }
  });
};

const verifyCwd = (cwd: string) =>
  Effect.tryPromise({
    try: () => stat(cwd),
    catch: (error) => processError("inspect working directory", error),
  }).pipe(
    Effect.flatMap((info) =>
      info.isDirectory()
        ? Effect.void
        : Effect.fail(
            new LocalProcessError({
              operation: "inspect working directory",
              message: `Working directory is not a directory: ${cwd}`,
            }),
          ),
    ),
  );

const acquireProcess = Effect.fn("LocalProcess.acquire")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  request: LocalProcessRequest,
) {
  yield* verifyCwd(request.cwd);
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
      const baseExit = { exitCode: observed.code };
      const result = observed.signal ? { ...baseExit, signal: observed.signal } : baseExit;
      return terminateLingeringGroup(pid).pipe(Effect.as(result));
    }),
    Effect.forkScoped({ startImmediately: true }),
  );

  const forceTermination =
    process.platform === "win32"
      ? terminateWindowsTree(pid, "force")
      : child.isRunning.pipe(
          Effect.catch(() => Effect.succeed(true)),
          Effect.flatMap((running) =>
            running
              ? child.kill({ killSignal: "SIGKILL" }).pipe(
                  Effect.timeoutOption("2 seconds"),
                  Effect.flatMap((outcome) =>
                    outcome._tag === "Some"
                      ? Effect.void
                      : Effect.fail(processError("terminate", "cleanup timed out")),
                  ),
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
      Effect.timeoutOption("2500 millis"),
      Effect.catch(() => Effect.succeedNone),
      Effect.asVoid,
      Effect.ensuring(Effect.sync(closeOutput)),
    ),
  };
});

export class LocalProcess extends Context.Service<LocalProcess, LocalProcessContract>()(
  "pi-background-terminals/boundary/local-process/LocalProcess",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return LocalProcess.of({
        spawn: (request) =>
          Effect.acquireRelease(acquireProcess(spawner, request), (handle) => handle.release).pipe(
            Effect.map(({ release: _release, ...handle }) => handle),
          ),
      });
    }),
  ).pipe(Layer.provide(nodeProcessLayer));
}
