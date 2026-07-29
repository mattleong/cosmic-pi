import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { ChildWireEvent } from "../boundary/child-process.ts";
import {
  claudeEnvelopeToAgentEvents,
  decodeClaudeStreamEnvelope,
} from "../boundary/claude-protocol.ts";
import type { ChildAgentEvent, ChildRateLimitEvent } from "./child-agent.ts";
import type { SubagentNotification } from "../boundary/host-notifier.ts";
import type { SubagentError } from "./errors.ts";
import { SubagentProcessError, SubagentProtocolError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import {
  assistantText,
  decodeAssistantMessage,
  decodeContactParentEnvelope,
  decodeRpcUsageOption,
  decodeRpcEnvelope,
  type ContactParentEnvelope,
} from "./protocol.ts";
import {
  appendAssistantSessionEvent,
  appendNoticeSessionEvent,
  finishToolSessionEvent,
  startToolSessionEvent,
} from "./session-events.ts";
import {
  addUsage,
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  sanitizeDiagnosticText,
  sanitizeOutputText,
  usageFromMessage,
} from "./state.ts";

const ACTIVITY_PUBLISH_INTERVAL_MILLIS = 1_000;

export interface RunEventDependencies {
  readonly mutateView: (
    record: RunRecord,
    update: (view: SubagentRunView) => SubagentRunView | undefined,
  ) => Effect.Effect<SubagentRunView | undefined>;
  readonly settle: (
    record: RunRecord,
    state: "completed" | "failed" | "stopped",
    error?: string,
  ) => Effect.Effect<SubagentRunView>;
  readonly notify: (
    record: RunRecord,
    notification:
      | Omit<Extract<SubagentNotification, { type: "question" }>, "generation">
      | Omit<Extract<SubagentNotification, { type: "warning" }>, "generation">,
  ) => Effect.Effect<void>;
  readonly failPendingResponses: (record: RunRecord, error: SubagentError) => void;
  readonly failRun: (
    record: RunRecord,
    message: string,
    pendingError?: SubagentError,
  ) => Effect.Effect<SubagentRunView>;
  readonly deliverForeground: (record: RunRecord, view: SubagentRunView) => boolean;
  readonly pauseFromEvent: (
    record: RunRecord,
    now: number,
  ) => Effect.Effect<SubagentRunView | undefined>;
  readonly handleRateLimit: (record: RunRecord, event: ChildRateLimitEvent) => Effect.Effect<void>;
}

const protocolError = (message: string) => new SubagentProtocolError({ message });
const isRawRpcResponse = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  (value as { readonly type?: unknown }).type === "response";

export function makeRunEventHandler(dependencies: RunEventDependencies) {
  const {
    mutateView,
    settle,
    notify,
    failPendingResponses,
    failRun,
    deliverForeground,
    pauseFromEvent,
    handleRateLimit,
  } = dependencies;

  const handleContact = (record: RunRecord, envelope: ContactParentEnvelope) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const message = sanitizeDiagnosticText(envelope.message, 16 * 1024);
      if (envelope.kind === "progress") {
        yield* mutateView(record, (current) =>
          current.state === "paused"
            ? undefined
            : {
                ...current,
                progress: message,
                lastActivityAt: now,
                sessionEvents: appendNoticeSessionEvent(
                  current.sessionEvents,
                  "progress",
                  message,
                  now,
                ),
              },
        );
        return;
      }
      if (envelope.kind === "warning") {
        const duplicate = record.view.warning === message;
        const view = yield* mutateView(record, (current) =>
          current.state === "paused"
            ? undefined
            : {
                ...current,
                warning: message,
                lastActivityAt: now,
                sessionEvents: appendNoticeSessionEvent(
                  current.sessionEvents,
                  "warning",
                  message,
                  now,
                ),
              },
        );
        if (!view || duplicate) return;
        const triggerTurn = !record.warningTurnTriggered;
        record.warningTurnTriggered = true;
        yield* notify(record, {
          type: "warning",
          id: view.id,
          name: view.name,
          message,
          triggerTurn,
        });
        return;
      }
      const view = yield* mutateView(record, (current) => {
        if (current.state !== "running") return undefined;
        if (record.replyPendingRequestId === envelope.requestId) return undefined;
        // A distinct child request is authoritative evidence that the uncertain prior reply turn
        // resolved. Permit exactly the new request while retaining same-request duplicate safety.
        record.replyPendingRequestId = undefined;
        return {
          ...current,
          state: "waiting_for_parent",
          lastActivityAt: now,
          question: { requestId: envelope.requestId, message, createdAt: now },
          sessionEvents: appendNoticeSessionEvent(current.sessionEvents, "question", message, now),
        };
      });
      if (!view) return;
      if (!deliverForeground(record, view)) {
        yield* notify(record, {
          type: "question",
          id: view.id,
          name: view.name,
          requestId: envelope.requestId,
          message,
        });
      }
    });

  const handleRpcEnvelope = (record: RunRecord, value: unknown) =>
    decodeRpcEnvelope(value).pipe(
      Effect.mapError(() => protocolError("Subagent emitted an invalid protocol event.")),
      Effect.flatMap((envelope) => {
        if (envelope.type === "response") {
          if (envelope.id) {
            const response = record.responses.get(envelope.id);
            if (response) Deferred.doneUnsafe(response, Effect.succeed(envelope));
          }
          return Effect.void;
        }
        if (isInactiveRunRecord(record)) return Effect.void;
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
                  Effect.flatMap((now) => pauseFromEvent(record, now)),
                  Effect.flatMap((view) =>
                    view || record.stoppedByParent
                      ? Effect.void
                      : settle(record, "completed").pipe(Effect.asVoid),
                  ),
                )
              : record.stoppedByParent
                ? Effect.void
                : settle(record, "completed").pipe(Effect.asVoid);
          case "message_update": {
            const event = envelope.assistantMessageEvent;
            if (event.type !== "text_delta" || !event.delta) return Effect.void;
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) =>
                  now - current.lastActivityAt < ACTIVITY_PUBLISH_INTERVAL_MILLIS
                    ? undefined
                    : {
                        ...current,
                        lastActivityAt: now,
                      },
                ),
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
                record.latestAssistantText = text
                  ? sanitizeOutputText(text, MAX_FINAL_TEXT_CHARS)
                  : undefined;
                return Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) =>
                    mutateView(record, (current) => ({
                      ...current,
                      lastActivityAt: now,
                      ...(record.latestAssistantText
                        ? {
                            sessionEvents: appendAssistantSessionEvent(
                              current.sessionEvents,
                              record.latestAssistantText,
                              now,
                            ),
                          }
                        : {}),
                      usage: addUsage(
                        current.usage,
                        usageFromMessage(decodeRpcUsageOption(message.usage)),
                      ),
                    })),
                  ),
                  Effect.asVoid,
                );
              }),
            );
          case "tool_execution_start":
            if (record.view.state === "paused") return Effect.void;
            record.activeTools.set(envelope.toolCallId, envelope.toolName);
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) => ({
                  ...current,
                  currentTool: [...record.activeTools.values()].at(-1),
                  lastActivityAt: now,
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
            if (record.view.state === "paused") return Effect.void;
            record.activeTools.delete(envelope.toolCallId);
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                mutateView(record, (current) => ({
                  ...current,
                  currentTool: [...record.activeTools.values()].at(-1),
                  lastActivityAt: now,
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
            return Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis;
              const message = sanitizeDiagnosticText(envelope.error, MAX_ERROR_CHARS);
              const duplicate = record.view.warning === message;
              const view = yield* mutateView(record, (current) => ({
                ...current,
                warning: message,
                lastActivityAt: now,
                sessionEvents: appendNoticeSessionEvent(
                  current.sessionEvents,
                  "warning",
                  `Extension error: ${message}`,
                  now,
                ),
              }));
              if (!view || duplicate) return;
              const triggerTurn = !record.warningTurnTriggered;
              record.warningTurnTriggered = true;
              yield* notify(record, {
                type: "warning",
                id: view.id,
                name: view.name,
                message,
                triggerTurn,
              });
            });
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

  const handleAgentEvent = (
    record: RunRecord,
    event: ChildAgentEvent,
  ): Effect.Effect<void, SubagentError> => {
    switch (event.type) {
      case "assistant":
        return handleRpcEnvelope(record, {
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: event.text }] },
        });
      case "tool_started":
        return handleRpcEnvelope(record, {
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
      case "tool_finished":
        return handleRpcEnvelope(record, {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: {},
          isError: event.isError,
        });
      case "rate_limit":
        return handleRateLimit(record, event);
      case "failed":
        return Effect.gen(function* () {
          const usage = event.usage;
          if (usage)
            yield* mutateView(record, (current) => ({
              ...current,
              usage: addUsage(current.usage, usage),
            }));
          const message =
            event.fallbackMessage && record.rateLimitRejected && record.rateLimitWarning
              ? record.rateLimitWarning
              : event.message;
          yield* failRun(record, message);
        }).pipe(Effect.asVoid);
      case "settled":
        return Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const finalText = event.finalText
            ? sanitizeOutputText(event.finalText, MAX_FINAL_TEXT_CHARS)
            : undefined;
          const duplicatesLatestAssistant =
            finalText !== undefined && finalText === record.latestAssistantText;
          if (finalText) record.latestAssistantText = finalText;
          yield* mutateView(record, (current) => ({
            ...current,
            lastActivityAt: now,
            ...(event.usage ? { usage: addUsage(current.usage, event.usage) } : {}),
            ...(finalText && !duplicatesLatestAssistant
              ? {
                  sessionEvents: appendAssistantSessionEvent(current.sessionEvents, finalText, now),
                }
              : {}),
          }));
          yield* settle(record, "completed");
        });
    }
  };

  const handleClaudeEnvelope = (
    record: RunRecord,
    value: unknown,
  ): Effect.Effect<void, SubagentError> =>
    decodeClaudeStreamEnvelope(value).pipe(
      Effect.mapError(() => protocolError("Claude emitted an invalid stream event.")),
      Effect.flatMap((envelope) =>
        Effect.forEach(
          claudeEnvelopeToAgentEvents(envelope, { tools: record.activeTools }),
          (event) => handleAgentEvent(record, event),
          { discard: true },
        ),
      ),
    );

  const handleIpcEnvelope = (record: RunRecord, value: unknown) =>
    decodeContactParentEnvelope(value).pipe(
      Effect.mapError(() => protocolError("Subagent emitted an invalid parent-contact event.")),
      Effect.flatMap((envelope) => handleContact(record, envelope)),
    );

  return (record: RunRecord, event: ChildWireEvent): Effect.Effect<void, SubagentError> => {
    if (event.type === "claude_message") {
      if (isInactiveRunRecord(record)) return Effect.void;
      return handleClaudeEnvelope(record, event.value);
    }
    if (event.type === "rpc_message") {
      // Raw RPC responses still settle pending requests on inactive records.
      if (!isRawRpcResponse(event.value) && isInactiveRunRecord(record)) return Effect.void;
      return handleRpcEnvelope(record, event.value);
    }
    if (event.type === "ipc_message") {
      if (isInactiveRunRecord(record)) return Effect.void;
      return handleIpcEnvelope(record, event.value);
    }
    if (event.type === "protocol_error") {
      if (isInactiveRunRecord(record)) return Effect.void;
      const error = protocolError(event.message);
      return failRun(record, error.message, error).pipe(Effect.asVoid);
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
    if (isInactiveRunRecord(record)) return Effect.void;
    return settle(record, "failed", processFailure.message).pipe(Effect.asVoid);
  };
}
