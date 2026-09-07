// Private JSONL process ownership shared by Pi RPC and the native CLI adapters.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { processCauseError, type SubagentProcessError } from "../run/errors.ts";
import { attachBoundedLineParser, makeByteBoundedQueueRoom } from "./bounded-line-parser.ts";
import { nodeSpawn, type NodeChildProcess } from "./node-builtins.ts";
import { terminateProcessTree, terminateProcessTreeEffect } from "./process-tree.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";

export const MAX_PROCESS_LINE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const EVENT_CAPACITY = 512;
const WRITE_TIMEOUT = "10 seconds";

export type ProcessWireEvent<Message> =
  | Message
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal?: string;
      readonly stderr: string;
    };
type ProcessExit = Extract<ProcessWireEvent<never>, { readonly type: "exit" }>;

export interface ChildProcessReleaseOperations {
  readonly platform: NodeJS.Platform;
  readonly requestAbort: Effect.Effect<void>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
  readonly awaitExit: Effect.Effect<unknown>;
}

const cleanupUnconfirmed = () =>
  processCauseError(
    "confirm subagent process cleanup",
    new Error("Process exit was not confirmed after forced termination."),
    "cleanup_unconfirmed",
  );

export const releaseChildProcess = (
  operations: ChildProcessReleaseOperations,
): Effect.Effect<void, SubagentProcessError> => {
  const waitForExit = operations.awaitExit.pipe(
    Effect.interruptible,
    Effect.as(true),
    Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }),
  );
  return operations.requestAbort.pipe(
    Effect.andThen(Effect.sleep("100 millis")),
    Effect.andThen(Effect.exit(operations.terminate("graceful"))),
    Effect.flatMap((gracefulAttempt) =>
      waitForExit.pipe(
        Effect.flatMap((gracefulExit) => {
          if (gracefulExit) {
            if (operations.platform === "win32")
              return Exit.isSuccess(gracefulAttempt)
                ? Effect.void
                : Effect.fail(cleanupUnconfirmed());
            return Effect.sleep("100 millis").pipe(
              // POSIX descendants remain owned after the detached group leader exits.
              Effect.andThen(operations.terminate("force")),
            );
          }
          return Effect.exit(operations.terminate("force")).pipe(
            Effect.flatMap((forceAttempt) =>
              waitForExit.pipe(
                Effect.flatMap((forcedExit) =>
                  Exit.isSuccess(forceAttempt) && forcedExit
                    ? Effect.void
                    : Effect.fail(cleanupUnconfirmed()),
                ),
              ),
            ),
          );
        }),
      ),
    ),
  );
};

/** Owned process operations, injectable without replacing Node or provider modules. */
export interface ProcessTransportRuntime {
  readonly spawn: (...args: Parameters<typeof nodeSpawn>) => NodeChildProcess;
  readonly terminate: typeof terminateProcessTreeEffect;
  readonly force: typeof terminateProcessTree;
}
const nodeRuntime: ProcessTransportRuntime = {
  spawn: nodeSpawn,
  terminate: terminateProcessTreeEffect,
  force: terminateProcessTree,
};

interface ProcessTransportOptions<Message, Frame, Attachment> {
  readonly spawn: (spawn: ProcessTransportRuntime["spawn"]) => NodeChildProcess;
  readonly platform: NodeJS.Platform;
  readonly label: string;
  readonly error: <ErrorInput>(
    operation: string,
    error?: ErrorInput,
    code?: string,
  ) => SubagentProcessError;
  readonly message: <ValueInput>(value: ValueInput) => Message;
  readonly encode: (frame: Frame) => string;
  readonly maxOutboundBytes?: number;
  readonly terminateOnParserOverflow: boolean;
  readonly synchronousWriteFailure: "not_sent" | "defect";
  readonly requestAbort?: (
    send: (frame: Frame) => Effect.Effect<void, SubagentProcessError>,
  ) => Effect.Effect<void>;
  /** Attach extra channels before waiting for spawn, and detach only this acquisition's listeners. */
  readonly attach: (
    child: NodeChildProcess,
    offer: (event: ProcessWireEvent<Message>) => void,
  ) => { readonly value: Attachment; readonly detach: () => void };
}

/** Callers hand the acquired release to acquireRelease without an interruptible gap. */
export const acquireProcessTransport = Effect.fn("ProcessTransport.acquire")(function* <
  Message extends object,
  Frame,
  Attachment,
>(
  options: ProcessTransportOptions<Message, Frame, Attachment>,
  runtime: ProcessTransportRuntime = nodeRuntime,
) {
  const events = yield* Queue.dropping<ProcessWireEvent<Message>, Cause.Done>(EVENT_CAPACITY);
  const ready = yield* Deferred.make<void, SubagentProcessError>();
  const exited = yield* Deferred.make<ProcessExit>();
  const { platform, label, error: processError } = options;
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  let settled = false;
  let spawned = false;
  let cleaned = false;
  let queueOverflowed = false;
  let backlogOverflowed = false;
  let stdinError: Error | undefined;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const child = yield* Effect.try({
        try: () => options.spawn(runtime.spawn),
        catch: (error) => processError("spawn", error),
      });
      const force = () => {
        void runtime.force(child, "force", { platform }).catch(() => {});
      };
      const appendStderr = (chunk: Buffer) => {
        stderr.push(chunk);
        stderrBytes += chunk.byteLength;
        while (stderrBytes > MAX_STDERR_BYTES) {
          const first = stderr[0];
          if (!first) break;
          const excess = stderrBytes - MAX_STDERR_BYTES;
          if (first.byteLength <= excess) stderr.shift();
          else stderr[0] = first.subarray(excess);
          stderrBytes -= Math.min(first.byteLength, excess);
        }
      };
      const room = makeByteBoundedQueueRoom(events, MAX_QUEUED_BYTES, () => {
        backlogOverflowed = true;
        appendStderr(Buffer.from(`\n${label} event backlog exceeded ${MAX_QUEUED_BYTES} bytes.`));
        Queue.offerUnsafe(events, {
          type: "protocol_error" as const,
          message: `${label} event backlog exceeded its byte budget.`,
        });
        force();
      });
      const offer = (event: ProcessWireEvent<Message>, bytes = 0) => {
        if (room.offer(event, bytes) || backlogOverflowed || queueOverflowed) return;
        queueOverflowed = true;
        appendStderr(
          Buffer.from(`\n${label} event queue exceeded ${EVENT_CAPACITY} pending events.`),
        );
        force();
      };
      const detachStdout = child.stdout
        ? attachBoundedLineParser(child.stdout, {
            maxLineBytes: MAX_PROCESS_LINE_BYTES,
            maxQueuedBytes: MAX_QUEUED_BYTES,
            onLine: (line) => {
              const decoded = decodeUnknownJsonOption(line);
              offer(
                Option.isSome(decoded)
                  ? options.message(decoded.value)
                  : {
                      type: "protocol_error",
                      message: `${label} emitted malformed JSONL.`,
                    },
                Buffer.byteLength(line, "utf8") + 1,
              );
            },
            onOverflow: () => {
              offer({
                type: "protocol_error",
                message: `${label} output exceeded its bounded parser budget.`,
              });
              if (options.terminateOnParserOverflow) force();
            },
          })
        : () => {};
      const onStdoutError = (error: Error) => {
        appendStderr(Buffer.from(`\n${label} stdout error: ${error.message}\n`));
        offer({ type: "protocol_error", message: `${label} output stream failed.` });
      };
      const onStderrError = (error: Error) => {
        appendStderr(Buffer.from(`\n${label} stderr error: ${error.message}\n`));
        offer({ type: "protocol_error", message: `${label} diagnostic stream failed.` });
      };
      const onStdinError = (error: Error) => {
        stdinError = error;
      };
      const onSpawn = () => {
        spawned = true;
        Deferred.doneUnsafe(ready, Effect.void);
      };
      const attachment = options.attach(child, offer);
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        Queue.endUnsafe(events);
        Deferred.doneUnsafe(
          exited,
          Effect.succeed({
            type: "exit",
            exitCode,
            ...(signal && { signal }),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        );
      };
      const onError = (error: Error) => {
        Deferred.doneUnsafe(ready, Effect.fail(processError("spawn", error)));
        if (!spawned) finish(null, null);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        detachStdout();
        child.stdout?.off("error", onStdoutError);
        child.stderr?.off("data", appendStderr);
        child.stderr?.off("error", onStderrError);
        child.stdin?.off("error", onStdinError);
        child.off("spawn", onSpawn);
        attachment.detach();
        child.off("error", onError);
        child.off("close", onClose);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      child.stdout?.on("error", onStdoutError);
      child.stderr?.on("data", appendStderr);
      child.stderr?.on("error", onStderrError);
      child.stdin?.on("error", onStdinError);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("close", onClose);
      yield* Deferred.await(ready).pipe(Effect.onError(() => Effect.sync(cleanup)));
      const pid = child.pid;
      if (!pid) {
        cleanup();
        return yield* processError("spawn", "Process did not expose a pid.");
      }
      const send = (frame: Frame) =>
        Effect.callback<void, SubagentProcessError>((resume) => {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || stdinError) {
            resume(
              Effect.fail(
                processError(
                  "send frame to",
                  stdinError ?? "Process input is closed.",
                  "transport_not_sent",
                ),
              ),
            );
            return;
          }
          let encoded: string;
          try {
            encoded = options.encode(frame);
          } catch (error) {
            resume(Effect.fail(processError("encode frame for", error, "transport_not_sent")));
            return;
          }
          if (
            options.maxOutboundBytes !== undefined &&
            Buffer.byteLength(encoded, "utf8") > options.maxOutboundBytes
          ) {
            resume(
              Effect.fail(
                processError("encode frame for", "Frame exceeded limit.", "transport_not_sent"),
              ),
            );
            return;
          }
          try {
            stdin.write(encoded, (error) =>
              resume(
                error
                  ? Effect.fail(processError("send frame to", error, "transport_outcome_uncertain"))
                  : Effect.void,
              ),
            );
          } catch (error) {
            resume(
              options.synchronousWriteFailure === "defect"
                ? Effect.die(error)
                : Effect.fail(processError("send frame to", error, "transport_not_sent")),
            );
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: WRITE_TIMEOUT,
            orElse: () =>
              Effect.fail(
                processError(
                  "send frame to",
                  `Transport write exceeded ${WRITE_TIMEOUT}; delivery may already have occurred.`,
                  "transport_outcome_uncertain",
                ),
              ),
          }),
        );
      const terminate = (mode: "graceful" | "force") =>
        runtime
          .terminate(child, mode, { platform })
          .pipe(Effect.mapError((error) => processError("terminate", error)));
      // Mask through cache publication too: restoring interruption before cached's onExit
      // would remember interruption instead of the completed cleanup outcome.
      const release = yield* releaseChildProcess({
        platform,
        requestAbort: options.requestAbort?.(send) ?? Effect.void,
        terminate,
        awaitExit: Deferred.await(exited),
      }).pipe(Effect.ensuring(Effect.sync(cleanup)), Effect.cached);
      return {
        pid,
        events,
        acknowledge: room.acknowledge,
        awaitExit: Deferred.await(exited),
        send,
        terminate,
        release: Effect.uninterruptible(release),
        attachment: attachment.value,
      };
    }),
  );
});
