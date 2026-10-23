import { StringDecoder } from "node:string_decoder";
import {
  awaitProcessGroupExit,
  guardProcessGroupAtHostExit,
  nodeFilePlatformLayer,
  nodeSpawn,
  signalProcessGroup,
  utf8ByteLength,
  utf8Suffix,
  type NodeChildProcess,
  type ProcessGroupExitGuard,
} from "pi-cosmic-core";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BackgroundLogStream } from "../task/model.ts";

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
  /** Completes after the leader exits and its process group settles. */
  readonly awaitExit: Effect.Effect<LocalProcessExit>;
  /** The leader has exited, even if its process group is still settling. */
  readonly leaderExited: Effect.Effect<boolean>;
  readonly droppedOutputBytes: () => number;
  /** Ends the output stream and counts output that was never delivered as dropped. */
  readonly abandonOutput: Effect.Effect<void>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, LocalProcessError>;
}

export class LocalProcessError extends Schema.TaggedError<
  LocalProcessError,
  { readonly brand: unique symbol }
>()("LocalProcessError", {
  operation: Schema.String,
  reason: Schema.Literals(["cwd", "spawn", "terminate"]),
  message: Schema.String,
}) {}

export interface LocalProcessContract {
  readonly spawn: (
    request: LocalProcessRequest,
  ) => Effect.Effect<LocalProcessHandle, LocalProcessError, Scope.Scope>;
}

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

export function makeBackgroundProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && !BLOCKED_ENVIRONMENT_KEYS.has(key),
    ),
  );
  if (environment.FORCE_COLOR === undefined && environment.NO_COLOR === undefined)
    environment.FORCE_COLOR = "1";
  return environment;
}

interface ProcessTreeTermination {
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, LocalProcessError>;
  readonly settleExit: Effect.Effect<void>;
}

interface GroupLeader {
  /** The leader's exit was observed. Until then its ID stays reserved for its group. */
  readonly exited: () => boolean;
  readonly awaitExit: Effect.Effect<LocalProcessExit>;
  /** Signals the leader alone, for a group that refuses the signal. */
  readonly kill: () => void;
}

const makePosixGroupTermination = Effect.fn("LocalProcess.makePosixGroupTermination")(function* (
  pid: number,
  leader: GroupLeader,
  exitGuard: ProcessGroupExitGuard,
) {
  const forceRequested = yield* Deferred.make<void>();
  let gracefulStop = false;
  // Once the group is confirmed gone or swept after leader exit, its ID may be reused, so it is
  // never signalled again.
  let groupSettled = false;
  const markSettled = Effect.suspend(() => {
    groupSettled = true;
    return exitGuard.release;
  });
  const sweepExitedGroup = Effect.suspend(() => {
    if (groupSettled) return Effect.void;
    signalProcessGroup(pid, "SIGKILL");
    return markSettled;
  });
  const forceLeader = Effect.suspend(() => {
    if (leader.exited()) return sweepExitedGroup;
    if (signalProcessGroup(pid, "SIGKILL") !== "present") leader.kill();
    return leader.awaitExit.pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.fail(processError("terminate")),
      }),
      Effect.andThen(
        Effect.suspend(() => (signalProcessGroup(pid, 0) === "absent" ? markSettled : Effect.void)),
      ),
    );
  });
  // The group ID stays reserved while the leader runs, so it is the only signal target.
  const signalGracefully = Effect.suspend(() => {
    gracefulStop = true;
    if (groupSettled) return Effect.void;
    return signalProcessGroup(pid, "SIGTERM") === "absent" ? markSettled : Effect.void;
  });
  return {
    terminate: (mode) =>
      mode === "force"
        ? Deferred.succeed(forceRequested, undefined).pipe(Effect.andThen(forceLeader))
        : signalGracefully,
    settleExit: Effect.suspend(() =>
      gracefulStop
        ? Effect.raceFirst(
            awaitProcessGroupExit(pid),
            Deferred.await(forceRequested).pipe(Effect.as(false)),
          )
        : Effect.succeed(false),
    ).pipe(Effect.flatMap((gone) => (gone ? markSettled : sweepExitedGroup))),
  } satisfies ProcessTreeTermination;
});

const verifyCwd = (fs: FileSystem.FileSystem, cwd: string) =>
  fs.stat(cwd).pipe(
    Effect.mapError(() => processError("cwd", cwd)),
    Effect.flatMap((info) =>
      info.type === "Directory"
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

/**
 * Starts the shell as the leader of its own process group. The boundary spawns it directly so
 * that it alone signals the group: Effect's process spawner signals a group again after a nonzero
 * exit, including at scope release, when the group may have settled and its ID been reused.
 *
 * It runs inside masked acquisition and registers no interruption handler on purpose: an
 * interrupted monitor waits for Node's spawn or error event, so a started child always reaches
 * the host-exit guard and group terminator that own its cleanup.
 */
const spawnGroupLeader = (
  request: LocalProcessRequest,
  leaderExit: Deferred.Deferred<LocalProcessExit>,
) =>
  Effect.callback<NodeChildProcess, LocalProcessError>((resume) => {
    let child: NodeChildProcess;
    try {
      child = nodeSpawn(request.command, [], {
        cwd: request.cwd,
        detached: true,
        env: makeBackgroundProcessEnvironment(process.env),
        shell: request.shellPath ?? true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resume(Effect.fail(processError("spawn")));
      return;
    }
    // Registered at spawn so no exit goes unobserved, and kept for the child's lifetime so a
    // later child error cannot surface as an unhandled host error.
    child.once("exit", (exitCode, signal) =>
      Deferred.doneUnsafe(leaderExit, Exit.succeed({ exitCode, ...(signal && { signal }) })),
    );
    child.on("error", () => resume(Effect.fail(processError("spawn"))));
    child.once("spawn", () => resume(Effect.succeed(child)));
  });

const acquireProcess = Effect.fn("LocalProcess.acquire")(function* (request: LocalProcessRequest) {
  const ingressBufferBytes = Math.max(1, Math.floor(request.ingressBufferBytes));
  const outputQueue = yield* Queue.dropping<LocalProcessOutput, Cause.Done>(INGRESS_CHUNKS);
  const decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  } satisfies Record<BackgroundLogStream, StringDecoder>;
  let queuedBytes = 0;
  let totalDroppedBytes = 0;
  let reportedDroppedBytes = 0;
  let outputClosed = false;
  let abandoned = false;

  const leaderExit = yield* Deferred.make<LocalProcessExit>();
  const child = yield* spawnGroupLeader(request, leaderExit);
  const pid = child.pid;
  if (pid === undefined) return yield* processError("spawn");
  // Covers host exits that skip scope cleanup until the group is confirmed settled.
  const exitGuard = yield* guardProcessGroupAtHostExit(pid);
  const tree = yield* makePosixGroupTermination(
    pid,
    {
      exited: () => Deferred.isDoneUnsafe(leaderExit),
      awaitExit: Deferred.await(leaderExit),
      kill: () => void child.kill("SIGKILL"),
    },
    exitGuard,
  );

  const takeQueued = () => {
    const taken = Queue.takeUnsafe(outputQueue);
    return taken !== undefined && Exit.isSuccess(taken) ? taken.value : undefined;
  };

  const offer = (stream: BackgroundLogStream, original: string) => {
    if (!original) return;
    // Output that arrives once delivery was abandoned is never delivered, so it counts as dropped.
    if (abandoned) {
      totalDroppedBytes += utf8ByteLength(original);
      return;
    }
    if (outputClosed) return;
    const tail = utf8Suffix(original, ingressBufferBytes);
    const tailBytes = utf8ByteLength(tail);
    totalDroppedBytes += utf8ByteLength(original) - tailBytes;
    if (!tail) return;

    while (Queue.isFullUnsafe(outputQueue) || queuedBytes + tailBytes > ingressBufferBytes) {
      const evicted = takeQueued();
      if (!evicted) break;
      const evictedBytes = utf8ByteLength(evicted.text);
      queuedBytes = Math.max(0, queuedBytes - evictedBytes);
      totalDroppedBytes += evictedBytes;
      reportedDroppedBytes = Math.max(0, reportedDroppedBytes - evicted.droppedBytes);
    }
    if (Queue.isFullUnsafe(outputQueue) || queuedBytes + tailBytes > ingressBufferBytes) {
      totalDroppedBytes += tailBytes;
      return;
    }
    const event = {
      stream,
      text: tail,
      droppedBytes: totalDroppedBytes - reportedDroppedBytes,
    } satisfies LocalProcessOutput;
    if (Queue.offerUnsafe(outputQueue, event)) {
      queuedBytes += tailBytes;
      reportedDroppedBytes = totalDroppedBytes;
    } else {
      totalDroppedBytes += tailBytes;
    }
  };
  const closeOutput = () => {
    if (outputClosed) return;
    offer("stdout", decoders.stdout.end());
    offer("stderr", decoders.stderr.end());
    outputClosed = true;
    Queue.endUnsafe(outputQueue);
  };
  // Queued bytes cover every event the reader has not received, including the rest of a batch it
  // already pulled, so they all become dropped here and the reader skips them, as it does anything
  // that arrives later. Undelivered gaps were already counted in the total.
  const abandonOutput = () => {
    outputClosed = true;
    abandoned = true;
    totalDroppedBytes += queuedBytes;
    queuedBytes = 0;
    while (takeQueued()) continue;
    Queue.endUnsafe(outputQueue);
  };
  let openStreams = 2;
  // Reading continues until each pipe ends, even after output closes, so a process that kept a
  // pipe never blocks on it; output arriving after closing is discarded, and after abandonment
  // it is also counted as dropped.
  const observe = (stream: BackgroundLogStream, source: NodeChildProcess["stdout"]) => {
    const ended = () => {
      openStreams -= 1;
      if (openStreams === 0) closeOutput();
    };
    if (!source) return ended();
    source.on("data", (chunk: Buffer) => offer(stream, decoders[stream].write(chunk)));
    source.once("error", () => offer("stderr", `\nLocal process ${stream} stream failed.\n`));
    // A pipe closes after it ends or fails.
    source.once("close", ended);
  };
  observe("stdout", child.stdout);
  observe("stderr", child.stderr);
  const exitFiber = yield* Deferred.await(leaderExit).pipe(
    Effect.tap(tree.settleExit),
    Effect.forkScoped({ startImmediately: true }),
  );

  // Each pull takes the whole queue, so delivery is recorded per event as the reader receives it.
  const output = Stream.fromQueue(outputQueue).pipe(
    Stream.mapEffect((event) =>
      Effect.sync(() => {
        if (abandoned) return undefined;
        queuedBytes = Math.max(0, queuedBytes - utf8ByteLength(event.text));
        return event;
      }),
    ),
    Stream.filter(Predicate.isNotUndefined),
  );

  return {
    pid,
    output,
    awaitExit: Fiber.join(exitFiber),
    leaderExited: Deferred.isDone(leaderExit),
    droppedOutputBytes: () => totalDroppedBytes,
    abandonOutput: Effect.sync(abandonOutput),
    terminate: tree.terminate,
    release: tree.terminate("force").pipe(
      Effect.timeoutOrElse({ duration: "2500 millis", orElse: () => Effect.void }),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          closeOutput();
          // A leader that outlived a failed kill no longer keeps the host running.
          child.unref();
        }),
      ),
    ),
  };
});

export class LocalProcess extends Context.Service<LocalProcess, LocalProcessContract>()(
  "pi-background-task/boundary/local-process/LocalProcess",
) {
  static readonly layerWith = (fileSystem: Layer.Layer<FileSystem.FileSystem>) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return LocalProcess.of({
          spawn: (request) =>
            verifyCwd(fs, request.cwd).pipe(
              Effect.andThen(
                // Acquisition stays uninterruptible; see spawnGroupLeader.
                Effect.acquireRelease(acquireProcess(request), (handle) => handle.release),
              ),
              Effect.map(({ release: _release, ...handle }) => handle),
            ),
        });
      }),
    ).pipe(Layer.provide(fileSystem));

  static readonly layer = this.layerWith(nodeFilePlatformLayer);
}
