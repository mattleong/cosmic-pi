import { absurd } from "effect/Function";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { BackendEvent, BackendHandle } from "../backend/model.ts";
import { type SubagentError, SubagentProcessError, SubagentProtocolError } from "./errors.ts";
import { isInactiveRunRecord, recordLatestAssistantText, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { RunProxyExecution } from "./proxy-execution.ts";
import type { RunSettlement } from "./settlement.ts";
import {
  appendAssistantSessionEvent,
  appendNoticeSessionEvent,
  finishToolSessionEvent,
  startToolSessionEvent,
} from "./session-events.ts";
import { addUsage, captureOutputText, MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";
import { recordRunWarning } from "./warnings.ts";
import { samePiModel } from "./model-catalog.ts";

const ACTIVITY_PUBLISH_INTERVAL_MILLIS = 1_000;

interface RunEventDependencies {
  readonly settlement: RunSettlement;
  readonly queueQuestionLocked: RunNotificationDelivery["queueActionNotificationLocked"];
  readonly onProxyEvent: RunProxyExecution;
}

type HandledBackendEvent = Exclude<
  BackendEvent,
  { readonly type: "usage" | "proxy_request" | "proxy_cancel" }
>;

const DELEGATED_EVENT_TYPES = [
  "backend_failure",
  "run_started",
  "run_settled",
  "report",
  "assistant_message",
  "tool_started",
  "supervisor_contact",
  "protocol_error",
  "exit",
] as const;

type DelegatedBackendEvent = Extract<
  HandledBackendEvent,
  { readonly type: (typeof DELEGATED_EVENT_TYPES)[number] }
>;

type ViewBackendEvent = Exclude<HandledBackendEvent, DelegatedBackendEvent>;

const isDelegatedEvent = (event: HandledBackendEvent): event is DelegatedBackendEvent =>
  DELEGATED_EVENT_TYPES.some((type) => type === event.type);

export function backendEventHandler(dependencies: RunEventDependencies) {
  const { settlement, queueQuestionLocked, onProxyEvent } = dependencies;

  const mutateAt = (
    record: RunRecord,
    assignmentEpoch: number | undefined,
    update: (view: SubagentRunView, now: number) => SubagentRunView | undefined,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        settlement.mutateEventView(record, assignmentEpoch, (view) => update(view, now)),
      ),
    );

  const handleContact = (
    record: RunRecord,
    envelope: Extract<BackendEvent, { readonly type: "supervisor_contact" }>,
  ) => {
    const message = sanitizeDiagnosticText(envelope.message, 16 * 1024);
    return mutateAt(record, envelope.assignmentEpoch, (current, now) => {
      if (envelope.kind !== "question" && current.state === "paused") return undefined;
      if (envelope.kind === "progress")
        return {
          ...current,
          progress: message,
          lastActivityAt: now,
          sessionEvents: appendNoticeSessionEvent(current.sessionEvents, "progress", message, now),
        };
      if (envelope.kind === "warning")
        return {
          ...current,
          ...recordRunWarning(record, current.sessionEvents, "child", message, now),
          lastActivityAt: now,
        };
      if (current.state !== "running") return undefined;
      if (record.replyPendingRequestId === envelope.requestId) return undefined;
      record.replyPendingRequestId = undefined;
      queueQuestionLocked(record, {
        type: "question",
        id: current.id,
        name: current.name,
        requestId: envelope.requestId,
        message,
      });
      return {
        ...current,
        state: "waiting_for_parent",
        lastActivityAt: now,
        question: { requestId: envelope.requestId, message },
        sessionEvents: appendNoticeSessionEvent(current.sessionEvents, "question", message, now),
      };
    });
  };

  const handleAssistantMessage = (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "assistant_message" }>,
  ) => {
    // Only the bounded text and its cut are kept: a Pi report is recaptured from its settlement,
    // and a submitted report carries its own text, so no intermediate message needs a full copy.
    const captured = captureOutputText({
      text: event.text ?? "",
      originalSize: event.originalSize,
    });
    const retained = captured && { text: captured.text, truncation: captured.truncation };
    const latestAssistantText = retained?.text;
    const replyModel = event.model;
    return mutateAt(record, event.assignmentEpoch, (current, now) => {
      recordLatestAssistantText(record, retained);
      return {
        ...current,
        ...(replyModel && !samePiModel(replyModel, current.model) && { model: replyModel }),
        lastActivityAt: now,
        ...(latestAssistantText && {
          sessionEvents: appendAssistantSessionEvent(
            current.sessionEvents,
            latestAssistantText,
            now,
          ),
        }),
        usage: addUsage(current.usage, event.usage),
      };
    });
  };

  const handleToolStarted = (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "tool_started" }>,
  ) =>
    mutateAt(record, event.assignmentEpoch, (current, now) => {
      if (current.state === "paused") return undefined;
      record.activeTools.set(event.toolCallId, event.toolName);
      return {
        ...current,
        sessionEvents: startToolSessionEvent(current.sessionEvents, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          startedAt: now,
        }),
        currentTool: [...record.activeTools.values()].at(-1),
        toolUses: Math.min(Number.MAX_SAFE_INTEGER, (current.toolUses ?? 0) + 1),
        lastActivityAt: now,
      };
    }).pipe(Effect.asVoid);

  const handleExit = (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "exit" }>,
  ) => {
    const processFailure =
      record.backendFailure ??
      event.failure ??
      new SubagentProcessError({
        operation: "run",
        message: sanitizeDiagnosticText(
          event.diagnostic.trim() ||
            `Subagent process exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`}.`,
          MAX_ERROR_CHARS,
        ),
      });
    record.process?.cancelPending(processFailure);
    return isInactiveRunRecord(record)
      ? Effect.void
      : event.failure
        ? settlement.failRun(record, processFailure.message, processFailure)
        : settlement.settle(
            record,
            "failed",
            sanitizeDiagnosticText(processFailure.message, MAX_ERROR_CHARS),
          );
  };

  const handleDelegatedEvent = (
    record: RunRecord,
    event: DelegatedBackendEvent,
  ): Effect.Effect<unknown, SubagentError> => {
    switch (event.type) {
      case "backend_failure":
        return settlement.failRun(record, event.error.message, event.error);
      case "run_started":
        return settlement.runStartedFromBackend(record, event.assignmentEpoch);
      case "run_settled":
        return settlement.runSettledFromBackend(
          record,
          event.assignmentEpoch,
          event.terminal,
          () => record.process?.controls.isSettlementCurrent?.(event) ?? true,
        );
      case "report":
        return settlement.acceptBackendReport(record, event);
      case "assistant_message":
        return handleAssistantMessage(record, event);
      case "tool_started":
        return handleToolStarted(record, event);
      case "supervisor_contact":
        return handleContact(record, event);
      case "protocol_error": {
        const error = new SubagentProtocolError({ message: event.message });
        return settlement.failRun(record, error.message, error);
      }
      case "exit":
        return handleExit(record, event);
    }
    return absurd(event);
  };

  const handleViewEvent = (
    record: RunRecord,
    event: ViewBackendEvent,
  ): Effect.Effect<unknown, SubagentError> => {
    switch (event.type) {
      case "input_delivery":
        return mutateAt(record, event.assignmentEpoch, (current, now) => {
          const owner = record.steeringDeliveryOwner;
          if (
            owner?.epoch === event.assignmentEpoch &&
            (event.sequence < owner.sequence ||
              (event.sequence === owner.sequence && current.steeringDelivery !== "pending"))
          )
            return undefined;
          record.steeringDeliveryOwner = { epoch: event.assignmentEpoch, sequence: event.sequence };
          const warning =
            event.state === "report-unconfirmed"
              ? "The supervisor report was accepted, but pending guidance acknowledgement and incorporation remain unconfirmed. Do not resend the guidance."
              : undefined;
          return {
            ...current,
            steeringDelivery: event.state,
            ...(warning && recordRunWarning(record, current.sessionEvents, "system", warning, now)),
          };
        });
      case "activity":
        return mutateAt(record, event.assignmentEpoch, (current, now) =>
          now - current.lastActivityAt < ACTIVITY_PUBLISH_INTERVAL_MILLIS
            ? undefined
            : { ...current, lastActivityAt: now },
        );
      case "native_agent_activity":
        return mutateAt(record, event.assignmentEpoch, (current, now) => {
          const activityId = sanitizeDiagnosticText(event.activityId, 256);
          const kind = sanitizeDiagnosticText(event.kind, 128);
          let total = current.nativeActivity?.total ?? 0;
          if (event.state === "running") {
            if (!record.nativeAgents.has(activityId) && record.nativeAgents.size < 64) {
              record.nativeAgents.add(activityId);
              total = Math.min(Number.MAX_SAFE_INTEGER, total + 1);
            }
          } else if (event.state !== "activity") record.nativeAgents.delete(activityId);
          return {
            ...current,
            lastActivityAt: now,
            nativeActivity: {
              active: record.nativeAgents.size,
              total,
              latest: { id: activityId, kind, state: event.state, updatedAt: now },
            },
          };
        });
      case "tool_finished":
        return mutateAt(record, event.assignmentEpoch, (current, now) => {
          if (current.state === "paused") return undefined;
          record.activeTools.delete(event.toolCallId);
          return {
            ...current,
            currentTool: [...record.activeTools.values()].at(-1),
            lastActivityAt: now,
            sessionEvents: finishToolSessionEvent(current.sessionEvents, {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
              endedAt: now,
              outputPreview: event.outputPreview,
            }),
          };
        });
      case "parent_question_cancelled":
        return settlement.mutateEventView(record, event.assignmentEpoch, (current) => {
          const waitingForQuestion =
            current.state === "waiting_for_parent" &&
            current.question?.requestId === event.requestId;
          const replyingToQuestion = record.replyPendingRequestId === event.requestId;
          if (!waitingForQuestion && !replyingToQuestion) return undefined;
          record.replyPendingRequestId = undefined;
          return waitingForQuestion
            ? { ...current, state: "running", question: undefined }
            : { ...current };
        });
      case "warning": {
        const message = sanitizeDiagnosticText(event.message, MAX_ERROR_CHARS);
        return mutateAt(record, undefined, (current, now) => ({
          ...current,
          ...recordRunWarning(
            record,
            current.sessionEvents,
            "system",
            message,
            now,
            `Extension error: ${message}`,
          ),
          lastActivityAt: now,
        }));
      }
    }
    return absurd(event);
  };

  const handleEvent = (
    record: RunRecord,
    event: HandledBackendEvent,
  ): Effect.Effect<unknown, SubagentError> => {
    if (event.type !== "exit" && isInactiveRunRecord(record))
      return event.type === "assistant_message"
        ? settlement.mergeLateUsage(record, event.assignmentEpoch, event.usage)
        : Effect.void;
    return isDelegatedEvent(event)
      ? handleDelegatedEvent(record, event)
      : handleViewEvent(record, event);
  };

  return (record: RunRecord, event: BackendEvent, source?: BackendHandle) => {
    if (event.type === "usage")
      return settlement.mergeProcessUsage(record, source, event.usage).pipe(Effect.asVoid);
    if (event.type === "proxy_request" || event.type === "proxy_cancel")
      return onProxyEvent(record, event).pipe(Effect.asVoid);
    return handleEvent(record, event).pipe(Effect.asVoid);
  };
}

export type RunEventHandler = ReturnType<typeof backendEventHandler>;
