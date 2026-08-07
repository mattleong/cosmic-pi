// Node process ownership is intentionally isolated at this platform boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { BackgroundLogStream } from "../job/model.ts";
import { utf8ByteLength, utf8Tail } from "../job/utf8.ts";

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
  readonly output: Queue.Dequeue<LocalProcessOutput, Cause.Done>;
  readonly awaitExit: Effect.Effect<LocalProcessExit>;
  readonly droppedOutputBytes: () => number;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, LocalProcessError>;
}

export class LocalProcessError extends Schema.TaggedErrorClass<LocalProcessError>()(
  "LocalProcessError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface LocalProcessShape {
  readonly spawn: (
    request: LocalProcessRequest,
  ) => Effect.Effect<LocalProcessHandle, LocalProcessError, Scope.Scope>;
}

const processError = (operation: string, error: unknown) =>
  new LocalProcessError({
    operation,
    message: error instanceof Error ? error.message : `Unable to ${operation} local process.`,
  });

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined &&
        !BLOCKED_ENVIRONMENT_KEYS.has(key) &&
        key !== "PI_SESSION_FILE" &&
        key !== "PI_SESSION_ID",
    ),
  );
}

function terminateTree(child: ChildProcess, mode: "graceful" | "force"): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/T", ...(mode === "force" ? ["/F"] : [])];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.on("error", () => {});
    killer.unref();
    return;
  }
  const signal = mode === "force" ? "SIGKILL" : "SIGTERM";
  try {
    process.kill(-pid, signal);
  } catch {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        // Exit and termination can race; final settlement is observed separately.
      }
    }
  }
}

function terminateLingeringGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || process.platform === "win32") return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // A group-free normal exit is the common case.
  }
}

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

const acquireProcess = Effect.fn("LocalProcess.acquire")(function* (request: LocalProcessRequest) {
  yield* verifyCwd(request.cwd);
  const output = yield* Queue.dropping<LocalProcessOutput, Cause.Done>(INGRESS_CHUNKS);
  const ready = yield* Deferred.make<void, LocalProcessError>();
  const exited = yield* Deferred.make<LocalProcessExit>();
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const maxEventBytes = Math.max(1, Math.ceil(request.ingressBufferBytes / INGRESS_CHUNKS));
  let totalDroppedBytes = 0;
  let reportedDroppedBytes = 0;
  let outputClosed = false;
  let cleaned = false;
  let spawnError: string | undefined;

  const child = yield* Effect.try({
    try: () =>
      spawn(request.command, {
        cwd: request.cwd,
        detached: process.platform !== "win32",
        env: sanitizedEnvironment(),
        shell: request.shellPath ?? true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    catch: (error) => processError("spawn", error),
  });

  const offer = (stream: BackgroundLogStream, original: string) => {
    if (!original || outputClosed) return;
    const tail = utf8Tail(original, maxEventBytes);
    totalDroppedBytes += utf8ByteLength(original) - tail.bytes;
    const droppedBytes = totalDroppedBytes - reportedDroppedBytes;
    if (tail.text && Queue.offerUnsafe(output, { stream, text: tail.text, droppedBytes })) {
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
    Queue.endUnsafe(output);
  };
  const onStdout = (chunk: Buffer) => offer("stdout", stdoutDecoder.write(chunk));
  const onStderr = (chunk: Buffer) => offer("stderr", stderrDecoder.write(chunk));
  const onSpawn = () => {
    Deferred.doneUnsafe(ready, Effect.void);
  };
  const onError = (error: Error) => {
    spawnError = error.message;
    Deferred.doneUnsafe(ready, Effect.fail(processError("spawn", error)));
    Deferred.doneUnsafe(exited, Effect.succeed({ exitCode: null, error: error.message }));
    closeOutput();
    cleanup();
  };
  const settleExit = (code: number | null, signal: NodeJS.Signals | null) =>
    Deferred.doneUnsafe(
      exited,
      Effect.succeed({
        exitCode: code,
        ...(signal ? { signal } : {}),
        ...(spawnError ? { error: spawnError } : {}),
      }),
    );
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    terminateLingeringGroup(child);
    settleExit(code, signal);
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    closeOutput();
    settleExit(code, signal);
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    child.stdout?.off("data", onStdout);
    child.stderr?.off("data", onStderr);
    child.off("spawn", onSpawn);
    child.off("error", onError);
    child.off("exit", onExit);
    child.off("close", onClose);
    child.stdout?.destroy();
    child.stderr?.destroy();
    closeOutput();
  };

  child.stdout?.on("data", onStdout);
  child.stderr?.on("data", onStderr);
  child.once("spawn", onSpawn);
  child.once("error", onError);
  child.once("exit", onExit);
  child.once("close", onClose);

  yield* Deferred.await(ready);
  const pid = child.pid;
  if (!pid) return yield* processError("spawn", "Process did not expose a pid.");

  const terminate = (mode: "graceful" | "force") =>
    Effect.try({
      try: () => terminateTree(child, mode),
      catch: (error) => processError("terminate", error),
    });

  return {
    pid,
    output,
    awaitExit: Deferred.await(exited),
    droppedOutputBytes: () => totalDroppedBytes,
    terminate,
    release: terminate("force").pipe(
      Effect.andThen(Deferred.await(exited).pipe(Effect.timeoutOption("2 seconds"))),
      Effect.asVoid,
      Effect.catch(() => Effect.void),
      Effect.ensuring(Effect.sync(cleanup)),
    ),
  };
});

export class LocalProcess extends Context.Service<LocalProcess, LocalProcessShape>()(
  "pi-background-terminals/boundary/local-process/LocalProcess",
) {
  static readonly layer = Layer.succeed(this, {
    spawn: (request) =>
      Effect.acquireRelease(acquireProcess(request), (handle) => handle.release).pipe(
        Effect.map(({ release: _release, ...handle }) => handle),
      ),
  });
}
