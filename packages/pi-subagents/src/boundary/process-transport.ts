// Private JSONL process ownership shared by Pi RPC and the native Claude/Codex CLI adapters.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { processCauseError, type SubagentProcessError } from "../run/errors.ts";
import { attachBoundedLineParser } from "./bounded-line-parser.ts";
import { nodeSpawn, type NodeChildProcess } from "./node-builtins.ts";
import { terminateProcessTree } from "./process-tree.ts";
import { decodeUnknownJsonOption } from "./wire-shared.ts";

export const MAX_PROCESS_LINE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const EVENT_CAPACITY = 512;
const WRITE_TIMEOUT = "10 seconds";

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly stderr: string;
}

/** Process exit is published only through `awaitExit`, never on the event queue. */
export type ProcessWireEvent<Message> =
  | Message
  | { readonly type: "protocol_error"; readonly message: string };

/** The owned process surface the local Pi, Claude, and Codex adapters consume. */
export interface ProcessTransportHandle<Message, Frame> {
  readonly pid: number;
  readonly events: Queue.Dequeue<ProcessWireEvent<Message>, Cause.Done>;
  /** Release byte-weighted transport backlog ownership after one event is processed. */
  readonly acknowledge: (event: ProcessWireEvent<Message>) => void;
  readonly awaitExit: Effect.Effect<ProcessExit, SubagentProcessError>;
  readonly send: (frame: Frame) => Effect.Effect<void, SubagentProcessError>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

// Frames are locally constructed protocol values, each serialized as one JSONL line.
const encodeFrame = <Frame>(frame: Frame): string => `${JSON.stringify(frame)}\n`;

const cleanupUnconfirmed = () =>
  processCauseError(
    "confirm subagent process cleanup",
    new Error("Process exit was not confirmed after forced termination."),
    "cleanup_unconfirmed",
  );

/** Owned process operations, injectable without replacing Node or provider modules. */
export interface ProcessTransportRuntime {
  readonly spawn: (...args: Parameters<typeof nodeSpawn>) => NodeChildProcess;
  readonly terminate: typeof terminateProcessTree;
}
const nodeRuntime: ProcessTransportRuntime = { spawn: nodeSpawn, terminate: terminateProcessTree };

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
  readonly maxOutboundBytes?: number;
  readonly terminateOnParserOverflow: boolean;
  readonly synchronousWriteFailure: "not_sent" | "defect";
  readonly requestAbort?: (
    send: (frame: Frame) => Effect.Effect<void, SubagentProcessError>,
  ) => Effect.Effect<void>;
  /** Attach extra channels before waiting for spawn; `detach` removes only these listeners. */
  readonly attach: (
    child: NodeChildProcess,
    offer: (event: ProcessWireEvent<Message>) => void,
  ) => Attachment;
}

/**
 * Spawns one owned process in the caller's scope. Spawn through release-finalizer registration
 * stays masked, so scope closure always releases a process that exists.
 */
export const acquireProcessTransport = Effect.fn("ProcessTransport.acquire")(function* <
  Message extends object,
  Frame,
  Attachment extends { readonly detach: () => void },
>(
  options: ProcessTransportOptions<Message, Frame, Attachment>,
  runtime: ProcessTransportRuntime = nodeRuntime,
) {
  const events = yield* Queue.dropping<ProcessWireEvent<Message>, Cause.Done>(EVENT_CAPACITY);
  const ready = yield* Deferred.make<void, SubagentProcessError>();
  const exited = yield* Deferred.make<ProcessExit>();
  // Synchronous stream callbacks fork forced termination into this scope rather than a daemon.
  const runFork = yield* FiberSet.makeRuntime();
  const { platform, label, error: processError } = options;
  const stderr: Buffer[] = [];
  // Queued events stay weighted by their line bytes until the consumer acknowledges them; the
  // count-bounded queue remains the final item guard.
  const weights = new WeakMap<ProcessWireEvent<Message>, number>();
  let queuedBytes = 0;
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
      // Scope closure joins rather than interrupts an in-flight forced termination, so a Windows
      // taskkill /T /F always finishes walking the tree within its own deadline.
      const force = () => {
        runFork(
          Effect.uninterruptible(runtime.terminate(child, "force", { platform })).pipe(
            Effect.ignore,
          ),
        );
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
      const offer = (event: ProcessWireEvent<Message>, bytes = 0) => {
        if (backlogOverflowed) return;
        if (queuedBytes + bytes > MAX_QUEUED_BYTES) {
          backlogOverflowed = true;
          appendStderr(Buffer.from(`\n${label} event backlog exceeded ${MAX_QUEUED_BYTES} bytes.`));
          Queue.offerUnsafe(events, {
            type: "protocol_error",
            message: `${label} event backlog exceeded its byte budget.`,
          });
          return force();
        }
        if (Queue.offerUnsafe(events, event)) {
          weights.set(event, bytes);
          queuedBytes += bytes;
          return;
        }
        if (queueOverflowed) return;
        queueOverflowed = true;
        appendStderr(
          Buffer.from(`\n${label} event queue exceeded ${EVENT_CAPACITY} pending events.`),
        );
        force();
      };
      const acknowledge = (event: ProcessWireEvent<Message>) => {
        const weight = weights.get(event);
        if (weight === undefined) return;
        weights.delete(event);
        queuedBytes -= weight;
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
          const notSent = <ErrorInput>(operation: string, error: ErrorInput) =>
            resume(Effect.fail(processError(operation, error, "transport_not_sent")));
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || stdinError)
            return notSent("send frame to", stdinError ?? "Process input is closed.");
          let encoded: string;
          try {
            encoded = encodeFrame(frame);
          } catch (error) {
            return notSent("encode frame for", error);
          }
          if (
            options.maxOutboundBytes !== undefined &&
            Buffer.byteLength(encoded, "utf8") > options.maxOutboundBytes
          )
            return notSent("encode frame for", "Frame exceeded limit.");
          try {
            stdin.write(encoded, (error) =>
              resume(
                error
                  ? Effect.fail(processError("send frame to", error, "transport_outcome_uncertain"))
                  : Effect.void,
              ),
            );
          } catch (error) {
            if (options.synchronousWriteFailure === "defect") resume(Effect.die(error));
            else notSent("send frame to", error);
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
      const waitForExit = Deferred.await(exited).pipe(
        Effect.interruptible,
        Effect.as(true),
        Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed(false) }),
      );
      const release = Effect.gen(function* () {
        yield* options.requestAbort?.(send) ?? Effect.void;
        yield* Effect.sleep("100 millis");
        const gracefulAttempt = yield* Effect.exit(terminate("graceful"));
        if (yield* waitForExit) {
          if (platform === "win32") {
            if (Exit.isFailure(gracefulAttempt)) return yield* cleanupUnconfirmed();
            return;
          }
          yield* Effect.sleep("100 millis");
          // POSIX descendants remain owned after the detached group leader exits.
          return yield* terminate("force");
        }
        const forceAttempt = yield* Effect.exit(terminate("force"));
        // Wait even when the forced terminate failed, so a late exit is still observed.
        const forcedExit = yield* waitForExit;
        if (Exit.isFailure(forceAttempt) || !forcedExit) return yield* cleanupUnconfirmed();
      });
      yield* Effect.addFinalizer(() =>
        release.pipe(Effect.ensuring(Effect.sync(cleanup)), Effect.orDie),
      );
      return {
        pid,
        events,
        acknowledge,
        awaitExit: Deferred.await(exited),
        send,
        terminate,
        attachment,
      };
    }),
  );
});
