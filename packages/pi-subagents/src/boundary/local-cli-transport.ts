// Local CLI wire transport: child spawn, bounded stdout/stderr/JSONL event queue,
// backpressured writes, awaitExit, and fail-closed process-tree termination/release. This
// boundary owns no harness filesystem state and never imports the LocalCliProcess service.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import * as Predicate from "effect/Predicate";

import { spawn } from "node:child_process";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type {
  CodexInitializedNotification,
  CodexRequest,
} from "../backend/local-codex-protocol.ts";
import type {
  ClaudeControlRequestFrame,
  ClaudeUserFrame,
} from "../backend/local-claude-protocol.ts";
import { SubagentProcessError } from "../run/errors.ts";
import { attachBoundedLineParser, makeByteBoundedQueueRoom } from "./bounded-line-parser.ts";
import { releaseChildProcess } from "./child-process.ts";
import { terminateProcessTree } from "./process-tree.ts";

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const EVENT_CAPACITY = 512;
const WRITE_TIMEOUT = "10 seconds";

export type LocalCliWireEvent =
  | { readonly type: "message"; readonly value: unknown }
  | { readonly type: "protocol_error"; readonly message: string }
  | {
      readonly type: "exit";
      readonly exitCode: number | null;
      readonly signal?: string | undefined;
      readonly stderr: string;
    };

export type LocalCliOutboundFrame =
  | ClaudeUserFrame
  | ClaudeControlRequestFrame
  | CodexRequest
  | CodexInitializedNotification;

export interface LocalCliHandle {
  readonly pid: number;
  readonly events: Queue.Dequeue<LocalCliWireEvent, Cause.Done>;
  readonly awaitExit: Effect.Effect<
    Extract<LocalCliWireEvent, { readonly type: "exit" }>,
    SubagentProcessError
  >;
  readonly send: (value: LocalCliOutboundFrame) => Effect.Effect<void, SubagentProcessError>;
  readonly acknowledge: (event: LocalCliWireEvent) => void;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, SubagentProcessError>;
}

export interface LocalCliTransportRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Package-test seam only. */
  readonly platform?: NodeJS.Platform | undefined;
}

const processError = <ErrorInput>(operation: string, error?: ErrorInput, code?: string) =>
  new SubagentProcessError(
    (() => {
      const objectPart2651_0 = {
        operation,
        message:
          error instanceof Error
            ? error.message
            : Predicate.isString(error)
              ? error
              : `Unable to ${operation} local CLI process.`,
      };
      const objectPart2651_1 = code ? { ...objectPart2651_0, code } : objectPart2651_0;
      return objectPart2651_1;
    })(),
  );

interface BoundedTailChunks {
  readonly chunks: Buffer[];
  length: number;
}

const boundedAppend = (target: BoundedTailChunks, chunk: Buffer, maximum: number): void => {
  target.chunks.push(chunk);
  target.length += chunk.byteLength;
  while (target.length > maximum) {
    const first = target.chunks[0];
    if (!first) break;
    const excess = target.length - maximum;
    if (first.byteLength <= excess) {
      target.chunks.shift();
      target.length -= first.byteLength;
    } else {
      target.chunks[0] = first.subarray(excess);
      target.length -= excess;
    }
  }
};

const appendTailText = (target: BoundedTailChunks, text: string): void => {
  const chunk = Buffer.from(text, "utf8");
  target.chunks.push(chunk);
  target.length += chunk.byteLength;
};

const readTail = (target: BoundedTailChunks): string =>
  Buffer.concat(target.chunks).toString("utf8");

/** Spawns one local CLI child and owns its bounded wire transport until release. */
export const acquireLocalCliTransport = Effect.fn("LocalCliTransport.acquire")(function* (
  request: LocalCliTransportRequest,
) {
  const events = yield* Queue.dropping<LocalCliWireEvent, Cause.Done>(EVENT_CAPACITY);
  const ready = yield* Deferred.make<void, SubagentProcessError>();
  const exited = yield* Deferred.make<Extract<LocalCliWireEvent, { readonly type: "exit" }>>();
  const stderr: BoundedTailChunks = { chunks: [], length: 0 };
  let settled = false;
  let spawned = false;
  let cleaned = false;
  let stdinError: Error | undefined;

  return yield* Effect.uninterruptible(
    Effect.gen(function* () {
      const platform = request.platform ?? process.platform;
      const child = yield* Effect.try({
        try: () =>
          spawn(request.executable, [...request.args], {
            cwd: request.cwd,
            detached: platform !== "win32",
            env: request.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          }),
        catch: (error) => processError("spawn local CLI", error, "local_cli_spawn_failed"),
      });
      const room = makeByteBoundedQueueRoom(events, MAX_QUEUED_BYTES, () => {
        appendTailText(stderr, `\nLocal CLI event backlog exceeded ${MAX_QUEUED_BYTES} bytes.`);
        Queue.offerUnsafe(events, {
          type: "protocol_error",
          message: "Local CLI event backlog exceeded its byte budget.",
        });
        void terminateProcessTree(child, "force", { platform }).catch(() => undefined);
      });
      let queueOverflowed = false;
      const offer = (event: LocalCliWireEvent, bytes = 0) => {
        if (room.offer(event, bytes)) return;
        if (queueOverflowed) return;
        queueOverflowed = true;
        appendTailText(
          stderr,
          `\nLocal CLI event queue exceeded ${EVENT_CAPACITY} pending events.`,
        );
        void terminateProcessTree(child, "force", { platform }).catch(() => undefined);
      };
      const detachStdout = child.stdout
        ? attachBoundedLineParser(child.stdout, {
            maxLineBytes: MAX_LINE_BYTES,
            maxQueuedBytes: MAX_QUEUED_BYTES,
            onLine: (line) => {
              const bytes = Buffer.byteLength(line, "utf8") + 1;
              try {
                // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
                offer({ type: "message", value: JSON.parse(line) as unknown }, bytes);
              } catch {
                offer(
                  { type: "protocol_error", message: "Local CLI emitted malformed JSONL." },
                  bytes,
                );
              }
            },
            onOverflow: () => {
              offer({
                type: "protocol_error",
                message: "Local CLI output exceeded its bounded parser budget.",
              });
              void terminateProcessTree(child, "force", { platform }).catch(() => undefined);
            },
          })
        : () => {};
      const onStderr = (chunk: Buffer) => {
        boundedAppend(stderr, chunk, MAX_STDERR_BYTES);
      };
      const onStdoutError = (error: Error) => {
        onStderr(Buffer.from(`\nLocal CLI stdout error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Local CLI output stream failed." });
      };
      const onStderrError = (error: Error) => {
        onStderr(Buffer.from(`\nLocal CLI stderr error: ${error.message}\n`, "utf8"));
        offer({ type: "protocol_error", message: "Local CLI diagnostic stream failed." });
      };
      const onStdinError = (error: Error) => {
        stdinError = error;
      };
      const onSpawn = () => {
        spawned = true;
        Deferred.doneUnsafe(ready, Effect.void);
      };
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        Queue.endUnsafe(events);
        const event: Extract<LocalCliWireEvent, { readonly type: "exit" }> = (() => {
          const objectPart7875_0 = { type: "exit" as const, exitCode };
          const objectPart7875_1 = signal ? { ...objectPart7875_0, signal } : objectPart7875_0;
          const objectPart7875_2 = { ...objectPart7875_1, stderr: readTail(stderr) };
          return objectPart7875_2;
        })();
        Deferred.doneUnsafe(exited, Effect.succeed(event));
      };
      const onError = (error: Error) => {
        Deferred.doneUnsafe(
          ready,
          Effect.fail(processError("spawn local CLI", error, "local_cli_spawn_failed")),
        );
        if (!spawned) finish(null, null);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal);
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        detachStdout();
        child.stdout?.off("error", onStdoutError);
        child.stderr?.off("data", onStderr);
        child.stderr?.off("error", onStderrError);
        child.stdin?.off("error", onStdinError);
        child.off("spawn", onSpawn);
        child.off("error", onError);
        child.off("close", onClose);
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      child.stdout?.on("error", onStdoutError);
      child.stderr?.on("data", onStderr);
      child.stderr?.on("error", onStderrError);
      child.stdin?.on("error", onStdinError);
      child.once("spawn", onSpawn);
      child.once("error", onError);
      child.once("close", onClose);
      yield* Deferred.await(ready).pipe(Effect.onError(() => Effect.sync(cleanup)));
      const pid = child.pid;
      if (!pid) {
        cleanup();
        return yield* processError("spawn local CLI", "Process did not expose a pid.");
      }

      const send = (value: LocalCliOutboundFrame) =>
        Effect.callback<void, SubagentProcessError>((resumeWrite) => {
          const stdin = child.stdin;
          if (!stdin || stdin.destroyed || stdinError) {
            resumeWrite(
              Effect.fail(
                processError(
                  "send local CLI protocol frame to",
                  stdinError ?? "Local CLI input is closed.",
                  "transport_not_sent",
                ),
              ),
            );
            return;
          }
          let encoded: string;
          try {
            encoded = `${JSON.stringify(value)}\n`;
          } catch (error) {
            resumeWrite(
              Effect.fail(processError("encode local CLI frame for", error, "transport_not_sent")),
            );
            return;
          }
          if (Buffer.byteLength(encoded, "utf8") > MAX_LINE_BYTES) {
            resumeWrite(
              Effect.fail(
                processError(
                  "encode local CLI frame for",
                  "Frame exceeded limit.",
                  "transport_not_sent",
                ),
              ),
            );
            return;
          }
          stdin.write(encoded, (error) =>
            resumeWrite(
              error
                ? Effect.fail(
                    processError("send local CLI frame to", error, "transport_outcome_uncertain"),
                  )
                : Effect.void,
            ),
          );
        }).pipe(
          Effect.timeoutOption(WRITE_TIMEOUT),
          Effect.flatMap((outcome) =>
            outcome._tag === "Some"
              ? Effect.void
              : Effect.fail(
                  processError(
                    "send local CLI frame to",
                    `Transport write exceeded ${WRITE_TIMEOUT}; delivery may already have occurred.`,
                    "transport_outcome_uncertain",
                  ),
                ),
          ),
        );
      const terminate = (mode: "graceful" | "force") =>
        Effect.tryPromise({
          try: () => terminateProcessTree(child, mode, { platform }),
          catch: (error) => processError("terminate local CLI", error),
        });
      const release = releaseChildProcess({
        platform,
        requestAbort: Effect.void,
        terminate,
        awaitExit: Deferred.await(exited),
      }).pipe(Effect.ensuring(Effect.sync(cleanup)));
      return {
        pid,
        events,
        awaitExit: Deferred.await(exited),
        send,
        acknowledge: room.acknowledge,
        terminate,
        release,
      };
    }),
  );
});
