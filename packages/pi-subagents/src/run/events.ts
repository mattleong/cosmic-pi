import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { BackendEvent, BackendReport } from "../backend/model.ts";
import type { SubagentNotification } from "../boundary/host-notifier.ts";
import type { SubagentError } from "./errors.ts";
import { SubagentProcessError, SubagentProtocolError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
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
} from "./state.ts";
import { setRunWarning } from "./warnings.ts";

const ACTIVITY_PUBLISH_INTERVAL_MILLIS = 1_000;

export interface RunEventDependencies {
  readonly mutateView: (
    record: RunRecord,
    assignmentEpoch: number | undefined,
    update: (view: SubagentRunView) => SubagentRunView | undefined,
  ) => Effect.Effect<SubagentRunView | undefined>;
  readonly mergeLateUsage: (
    record: RunRecord,
    assignmentEpoch: number,
    usage: import("./model.ts").SubagentUsage,
  ) => Effect.Effect<void>;
  readonly runStarted: (record: RunRecord, assignmentEpoch: number) => Effect.Effect<void>;
  readonly runSettled: (record: RunRecord, assignmentEpoch: number) => Effect.Effect<void>;
  readonly acceptReport: (
    record: RunRecord,
    report: BackendReport,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly settle: (
    record: RunRecord,
    state: "completed" | "failed" | "stopped",
    error?: string,
  ) => Effect.Effect<SubagentRunView>;
  readonly notify: (
    record: RunRecord,
    notification: Omit<Extract<SubagentNotification, { type: "question" }>, "generation">,
  ) => Effect.Effect<void>;
  readonly failRun: (
    record: RunRecord,
    message: string,
    pendingError?: SubagentError,
  ) => Effect.Effect<SubagentRunView>;
}

const protocolError = (message: string) => new SubagentProtocolError({ message });

export function makeRunEventHandler(dependencies: RunEventDependencies) {
  const {
    mutateView,
    mergeLateUsage,
    runStarted,
    runSettled,
    acceptReport,
    settle,
    notify,
    failRun,
  } = dependencies;

  const handleContact = (
    record: RunRecord,
    envelope: Extract<BackendEvent, { readonly type: "supervisor_contact" }>,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const message = sanitizeDiagnosticText(envelope.message, 16 * 1024);
      if (envelope.kind === "progress") {
        yield* mutateView(record, envelope.assignmentEpoch, (current) =>
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
        yield* mutateView(record, envelope.assignmentEpoch, (current) => {
          if (current.state === "paused") return undefined;
          record.warningSlots = setRunWarning(record.warningSlots, "child", message);
          return {
            ...current,
            warning: message,
            lastActivityAt: now,
            sessionEvents: appendNoticeSessionEvent(current.sessionEvents, "warning", message, now),
          };
        });
        return;
      }
      const view = yield* mutateView(record, envelope.assignmentEpoch, (current) => {
        if (current.state !== "running") return undefined;
        if (record.replyPendingRequestId === envelope.requestId) return undefined;
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
      yield* notify(record, {
        type: "question",
        id: view.id,
        name: view.name,
        requestId: envelope.requestId,
        message,
      });
    });

  return (record: RunRecord, event: BackendEvent): Effect.Effect<void, SubagentError> => {
    if (event.type !== "exit" && isInactiveRunRecord(record)) {
      // A backend may report final cumulative usage/cost only at its native
      // result, after the accepted report already settled the run. That exact
      // epoch's usage still merges into the completed outcome.
      if (event.type === "assistant_message")
        return mergeLateUsage(record, event.assignmentEpoch, event.usage);
      return Effect.void;
    }
    switch (event.type) {
      case "run_started":
        return runStarted(record, event.assignmentEpoch);
      case "run_settled":
        return runSettled(record, event.assignmentEpoch);
      case "report":
        return acceptReport(record, event).pipe(Effect.asVoid);
      case "activity":
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            mutateView(record, event.assignmentEpoch, (current) =>
              now - current.lastActivityAt < ACTIVITY_PUBLISH_INTERVAL_MILLIS
                ? undefined
                : { ...current, lastActivityAt: now },
            ),
          ),
          Effect.asVoid,
        );
      case "assistant_message": {
        const latestAssistantText = event.text
          ? sanitizeOutputText(event.text, MAX_FINAL_TEXT_CHARS)
          : undefined;
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            mutateView(record, event.assignmentEpoch, (current) => {
              record.latestAssistantText = latestAssistantText;
              return (() => {
                const baseResult = { ...current, lastActivityAt: now };
                const withSessionEvents = latestAssistantText
                  ? {
                      ...baseResult,
                      sessionEvents: appendAssistantSessionEvent(
                        current.sessionEvents,
                        latestAssistantText,
                        now,
                      ),
                    }
                  : baseResult;
                const withUsage = {
                  ...withSessionEvents,
                  usage: addUsage(current.usage, event.usage),
                };
                return withUsage;
              })();
            }),
          ),
          Effect.asVoid,
        );
      }
      case "tool_started":
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            mutateView(record, event.assignmentEpoch, (current) => {
              if (current.state === "paused") return undefined;
              record.activeTools.set(event.toolCallId, event.toolName);
              return {
                ...current,
                currentTool: [...record.activeTools.values()].at(-1),
                lastActivityAt: now,
                sessionEvents: startToolSessionEvent(current.sessionEvents, {
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  args: event.args,
                  startedAt: now,
                }),
              };
            }),
          ),
          Effect.asVoid,
        );
      case "tool_finished":
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            mutateView(record, event.assignmentEpoch, (current) => {
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
                }),
              };
            }),
          ),
          Effect.asVoid,
        );
      case "supervisor_contact":
        return handleContact(record, event);
      case "supervisor_question_cancelled":
        return mutateView(record, event.assignmentEpoch, (current) => {
          const waitingForQuestion =
            current.state === "waiting_for_parent" &&
            current.question?.requestId === event.requestId;
          const replyingToQuestion = record.replyPendingRequestId === event.requestId;
          if (!waitingForQuestion && !replyingToQuestion) return undefined;
          record.replyPendingRequestId = undefined;
          return waitingForQuestion
            ? { ...current, state: "running", question: undefined }
            : { ...current };
        }).pipe(Effect.asVoid);
      case "warning":
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => {
            const message = sanitizeDiagnosticText(event.message, MAX_ERROR_CHARS);
            return mutateView(record, undefined, (current) => {
              record.warningSlots = setRunWarning(record.warningSlots, "system", message);
              return {
                ...current,
                warning: message,
                lastActivityAt: now,
                sessionEvents: appendNoticeSessionEvent(
                  current.sessionEvents,
                  "warning",
                  `Extension error: ${message}`,
                  now,
                ),
              };
            });
          }),
          Effect.asVoid,
        );
      case "protocol_error": {
        const error = protocolError(event.message);
        return failRun(record, error.message, error).pipe(Effect.asVoid);
      }
      case "exit": {
        const processFailure = new SubagentProcessError({
          operation: "run",
          message: sanitizeDiagnosticText(
            event.diagnostic.trim() ||
              `Subagent process exited${event.exitCode === null ? "" : ` with code ${event.exitCode}`}.`,
            MAX_ERROR_CHARS,
          ),
        });
        record.process?.cancelPending(processFailure);
        if (isInactiveRunRecord(record)) return Effect.void;
        return settle(record, "failed", processFailure.message).pipe(Effect.asVoid);
      }
    }
  };
}
