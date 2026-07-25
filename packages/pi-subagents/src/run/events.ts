import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ChildWireEvent } from "../boundary/child-process.ts";
import type { SubagentNotification } from "../boundary/host-notifier.ts";
import type { SubagentError } from "./errors.ts";
import { SubagentProcessError, SubagentProtocolError } from "./errors.ts";
import type { RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import {
  assistantText,
  decodeAssistantMessage,
  decodeChildEnvelope,
  type ContactParentEnvelope,
} from "./protocol.ts";
import {
  appendAssistantSessionEvent,
  appendNoticeSessionEvent,
  finishToolSessionEvent,
  startToolSessionEvent,
} from "./session-output.ts";
import {
  addUsage,
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
  usageFromMessage,
} from "./state.ts";
import { appendTranscript, appendTranscriptDelta } from "./transcript.ts";

export interface RunEventDependencies {
  readonly mutateView: (
    record: RunRecord,
    update: (view: SubagentRunView) => SubagentRunView,
  ) => Effect.Effect<SubagentRunView>;
  readonly settle: (
    record: RunRecord,
    state: "completed" | "failed" | "stopped",
    error?: string,
  ) => Effect.Effect<SubagentRunView>;
  readonly notify: (notification: SubagentNotification) => void;
  readonly failPendingResponses: (record: RunRecord, error: SubagentError) => void;
  readonly failRun: (record: RunRecord, message: string) => Effect.Effect<SubagentRunView>;
}

const protocolError = (message: string) => new SubagentProtocolError({ message });

export function makeRunEventHandler(dependencies: RunEventDependencies) {
  const { mutateView, settle, notify, failPendingResponses, failRun } = dependencies;

  const handleContact = (record: RunRecord, envelope: ContactParentEnvelope) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const message = sanitizeDiagnosticText(envelope.message, 16 * 1024);
      if (envelope.kind === "progress") {
        yield* mutateView(record, (current) => ({
          ...current,
          progress: message,
          lastActivityAt: now,
          transcript: appendTranscript(current.transcript, `progress: ${message}`),
          sessionEvents: appendNoticeSessionEvent(current.sessionEvents, "progress", message, now),
        }));
        return;
      }
      if (envelope.kind === "warning") {
        const view = yield* mutateView(record, (current) => ({
          ...current,
          warning: message,
          lastActivityAt: now,
          transcript: appendTranscript(current.transcript, `warning: ${message}`),
          sessionEvents: appendNoticeSessionEvent(current.sessionEvents, "warning", message, now),
        }));
        notify({ type: "warning", id: view.id, name: view.name, message });
        return;
      }
      const view = yield* mutateView(record, (current) => ({
        ...current,
        state: "waiting_for_parent",
        lastActivityAt: now,
        question: { requestId: envelope.requestId, message, createdAt: now },
        transcript: appendTranscript(current.transcript, `question for parent: ${message}`),
        sessionEvents: appendNoticeSessionEvent(current.sessionEvents, "question", message, now),
      }));
      Deferred.doneUnsafe(record.foregroundOutcome, Effect.succeed(view));
      if (record.view.execution === "background")
        notify({
          type: "question",
          id: view.id,
          name: view.name,
          requestId: envelope.requestId,
          message,
        });
    });

  const handleEnvelope = (record: RunRecord, value: unknown) =>
    decodeChildEnvelope(value).pipe(
      Effect.mapError(() => protocolError("Subagent emitted an invalid protocol event.")),
      Effect.flatMap((envelope) => {
        if ("channel" in envelope) return handleContact(record, envelope);
        switch (envelope.type) {
          case "response": {
            if (envelope.id) {
              const response = record.responses.get(envelope.id);
              if (response) Deferred.doneUnsafe(response, Effect.succeed(envelope));
            }
            return Effect.void;
          }
          default:
            if (record.view.state === "failed" || record.view.state === "stopped")
              return Effect.void;
        }
        switch (envelope.type) {
          case "agent_start":
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) => ({
                  ...current,
                  state: "running",
                  endedAt: undefined,
                  error: undefined,
                  lastActivityAt: now,
                })),
              ),
              Effect.asVoid,
            );
          case "agent_end":
            return Effect.void;
          case "agent_settled":
            return record.pauseRequested
              ? Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    mutateView(record, (current) => ({
                      ...current,
                      state: "paused",
                      lastActivityAt: now,
                      currentTool: undefined,
                    })),
                  ),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      record.pauseRequested = false;
                    }),
                  ),
                  Effect.asVoid,
                )
              : record.stoppedByParent || record.view.state === "stopping"
                ? Effect.void
                : settle(record, "completed").pipe(Effect.asVoid);
          case "message_update": {
            const event = envelope.assistantMessageEvent;
            if (event.type !== "text_delta" || !event.delta) return Effect.void;
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) => ({
                  ...current,
                  lastActivityAt: now,
                  transcript: appendTranscriptDelta(current.transcript, event.delta ?? ""),
                })),
              ),
              Effect.asVoid,
            );
          }
          case "message_end":
            return decodeAssistantMessage(envelope.message).pipe(
              Effect.mapError(() =>
                protocolError("Subagent emitted an invalid assistant message."),
              ),
              Effect.flatMap((message) => {
                if (!message) return Effect.void;
                const text = assistantText(message);
                return Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    mutateView(record, (current) => ({
                      ...current,
                      lastActivityAt: now,
                      ...(text
                        ? {
                            finalText: sanitizeOutputText(text, MAX_FINAL_TEXT_CHARS),
                            sessionEvents: appendAssistantSessionEvent(
                              current.sessionEvents,
                              text,
                              now,
                            ),
                          }
                        : {}),
                      usage: addUsage(current.usage, usageFromMessage(message.usage)),
                    })),
                  ),
                  Effect.asVoid,
                );
              }),
            );
          case "tool_execution_start":
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) => ({
                  ...current,
                  currentTool: envelope.toolName,
                  lastActivityAt: now,
                  transcript: appendTranscript(current.transcript, `▶ ${envelope.toolName}`),
                  sessionEvents: startToolSessionEvent(current.sessionEvents, {
                    toolCallId: envelope.toolCallId,
                    toolName: envelope.toolName,
                    args: envelope.args,
                    startedAt: now,
                  }),
                })),
              ),
              Effect.asVoid,
            );
          case "tool_execution_end":
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) => ({
                  ...current,
                  currentTool: undefined,
                  lastActivityAt: now,
                  transcript: appendTranscript(
                    current.transcript,
                    `${envelope.isError ? "×" : "✓"} ${envelope.toolName}`,
                  ),
                  sessionEvents: finishToolSessionEvent(current.sessionEvents, {
                    toolCallId: envelope.toolCallId,
                    toolName: envelope.toolName,
                    isError: envelope.isError,
                    endedAt: now,
                  }),
                })),
              ),
              Effect.asVoid,
            );
          case "extension_error":
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) => ({
                  ...current,
                  warning: sanitizeDiagnosticText(envelope.error, MAX_ERROR_CHARS),
                  lastActivityAt: now,
                  transcript: appendTranscript(
                    current.transcript,
                    `extension error: ${sanitizeDiagnosticText(envelope.error, MAX_ERROR_CHARS)}`,
                  ),
                  sessionEvents: appendNoticeSessionEvent(
                    current.sessionEvents,
                    "warning",
                    `Extension error: ${envelope.error}`,
                    now,
                  ),
                })),
              ),
              Effect.asVoid,
            );
          case "extension_ui_request": {
            const dialog = new Set(["select", "confirm", "input", "editor"]).has(envelope.method);
            return dialog && record.process
              ? record.process
                  .send({
                    type: "extension_ui_response",
                    id: envelope.id,
                    cancelled: true,
                  })
                  .pipe(Effect.catch(() => Effect.void))
              : Effect.void;
          }
          default:
            return Effect.void;
        }
      }),
    );

  return (record: RunRecord, event: ChildWireEvent) => {
    if (event.type === "message") return handleEnvelope(record, event.value);
    if (event.type === "protocol_error") {
      const error = protocolError(event.message);
      failPendingResponses(record, error);
      return failRun(record, error.message).pipe(Effect.asVoid);
    }
    const processFailure = new SubagentProcessError({
      operation: "run",
      message: sanitizeDiagnosticText(
        event.stderr.trim() ||
          `Subagent process exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`}.`,
        MAX_ERROR_CHARS,
      ),
    });
    failPendingResponses(record, processFailure);
    if (
      record.stoppedByParent ||
      record.view.state === "stopping" ||
      record.view.state === "stopped" ||
      record.view.state === "completed" ||
      record.view.state === "failed"
    )
      return Effect.void;
    return settle(record, "failed", processFailure.message).pipe(Effect.asVoid);
  };
}
