import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { BackendEvent, BackendHandle } from "../backend/model.ts";
import { type SubagentError, SubagentProcessError, SubagentProtocolError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
import type { RunNotificationDelivery } from "./notification-delivery.ts";
import type { RunProxyExecution } from "./proxy-execution.ts";
import type { RunSettlement } from "./settlement.ts";
import type { RunStructuredResults } from "./structured-result.ts";
import {
  bashCommandMayMutate,
  MAX_OBSERVED_WRITE_PATHS,
  MAX_WRITE_CLAIM_VIOLATIONS,
  observeFileWrite,
  workspaceRelativeObservedPath,
} from "./claims-observation.ts";
import {
  OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
  writeClaimContains,
} from "../domain/write-claims.ts";
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
import { SUBAGENT_RESULT_TOOL_NAME } from "./tool-policy.ts";
import { recordRunWarning } from "./warnings.ts";

const ACTIVITY_PUBLISH_INTERVAL_MILLIS = 1_000;

export interface RunEventDependencies {
  readonly settlement: RunSettlement;
  /** Called inside mutateEventView's locked transition before projection publication. */
  readonly queueQuestionLocked: RunNotificationDelivery["queueActionNotificationLocked"];
  /** Starts asynchronous containment after an unambiguous native file-tool violation. */
  readonly onWriteClaimViolation: (record: RunRecord, message: string) => Effect.Effect<void>;
  readonly onProxyEvent: RunProxyExecution;
  /** Answers every submission, including those of inactive runs, so a child never waits. */
  readonly onStructuredResult: RunStructuredResults;
}

export function makeRunEventHandler(dependencies: RunEventDependencies) {
  const {
    settlement,
    queueQuestionLocked,
    onWriteClaimViolation,
    onProxyEvent,
    onStructuredResult,
  } = dependencies;

  /** Reads the clock before mutateEventView takes the lock, then passes that time to `update`. */
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
        // A workflow keeps waiting only while it still owns the run.
        ...(current.workflow && record.owner?.live && { workflow: current.workflow }),
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
    const latestAssistantText = event.text
      ? sanitizeOutputText(event.text, MAX_FINAL_TEXT_CHARS)
      : undefined;
    return mutateAt(record, event.assignmentEpoch, (current, now) => {
      record.latestAssistantText = latestAssistantText;
      return {
        ...current,
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

  /** Observes paths and claims when the returned effect runs, before the view lock. */
  const handleToolStarted = (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "tool_started" }>,
  ) =>
    Effect.suspend(() => {
      const observed = observeFileWrite(event.toolName, event.args);
      const observedPaths =
        observed === undefined
          ? []
          : observed.length === 0
            ? [OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER]
            : observed.map(
                (path) =>
                  workspaceRelativeObservedPath(record.view.cwd, path) ??
                  OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
              );
      const claims = record.view.writeClaims;
      // A resolved relative path is never the marker, so the marker stands for unresolved paths.
      const violatingPaths =
        claims === undefined
          ? []
          : observedPaths.filter(
              (path) =>
                path === OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER || !writeClaimContains(claims, path),
            );
      const bashHint = bashCommandMayMutate(event.toolName, event.args);
      const violationMessage =
        violatingPaths.length > 0
          ? `Writer ${record.view.id} used ${event.toolName} outside its cooperative claims: ${violatingPaths.join(", ")}. Containment has started, and new writer admission is paused.`
          : undefined;
      return mutateAt(record, event.assignmentEpoch, (current, now) => {
        if (current.state === "paused") return undefined;
        record.activeTools.set(event.toolCallId, event.toolName);
        const writeAudit = current.writeAudit && {
          observedFileWrites: [
            ...new Set([...current.writeAudit.observedFileWrites, ...observedPaths]),
          ].slice(-MAX_OBSERVED_WRITE_PATHS),
          violations: [
            ...current.writeAudit.violations,
            ...violatingPaths.map((path) => ({ path, toolName: event.toolName, observedAt: now })),
          ].slice(-MAX_WRITE_CLAIM_VIOLATIONS),
          bashWriteHints: Math.min(
            Number.MAX_SAFE_INTEGER,
            current.writeAudit.bashWriteHints + (bashHint ? 1 : 0),
          ),
        };
        const sessionEvents = startToolSessionEvent(current.sessionEvents, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          startedAt: now,
        });
        return {
          ...current,
          ...(writeAudit && { writeAudit }),
          ...(violationMessage
            ? recordRunWarning(record, sessionEvents, "system", violationMessage, now)
            : { sessionEvents }),
          currentTool: [...record.activeTools.values()].at(-1),
          // Handing back a structured result is how the agent ends, not work it did.
          toolUses:
            event.toolName === SUBAGENT_RESULT_TOOL_NAME
              ? current.toolUses
              : Math.min(Number.MAX_SAFE_INTEGER, (current.toolUses ?? 0) + 1),
          lastActivityAt: now,
        };
      }).pipe(
        Effect.flatMap((updated) =>
          updated && violationMessage
            ? onWriteClaimViolation(record, violationMessage)
            : Effect.void,
        ),
      );
    });

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

  const handleEvent = (
    record: RunRecord,
    event: Exclude<
      BackendEvent,
      { readonly type: "usage" | "proxy_request" | "proxy_cancel" | "structured_result" }
    >,
  ): Effect.Effect<unknown, SubagentError> => {
    if (event.type !== "exit" && isInactiveRunRecord(record))
      // A backend may report final cumulative usage/cost only at its native result, after the
      // accepted report settled the run. That exact epoch's usage still merges into the outcome.
      return event.type === "assistant_message"
        ? settlement.mergeLateUsage(record, event.assignmentEpoch, event.usage)
        : Effect.void;
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
      case "backend_failure":
        return settlement.failRun(record, event.error.message, event.error);
      case "run_started":
        return settlement.runStartedFromBackend(record, event.assignmentEpoch);
      case "run_settled":
        return settlement.runSettledFromBackend(record, event.assignmentEpoch, event.terminal);
      case "report":
        return settlement.acceptBackendReport(record, event);
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
      case "assistant_message":
        return handleAssistantMessage(record, event);
      case "tool_started":
        return handleToolStarted(record, event);
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
            }),
          };
        });
      case "supervisor_contact":
        return handleContact(record, event);
      case "supervisor_question_cancelled":
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
      case "protocol_error": {
        const error = new SubagentProtocolError({ message: event.message });
        return settlement.failRun(record, error.message, error);
      }
      case "exit":
        return handleExit(record, event);
    }
  };

  return (record: RunRecord, event: BackendEvent, source?: BackendHandle) => {
    if (event.type === "usage")
      return settlement.mergeProcessUsage(record, source, event.usage).pipe(Effect.asVoid);
    if (event.type === "proxy_request" || event.type === "proxy_cancel")
      return onProxyEvent(record, event).pipe(Effect.asVoid);
    if (event.type === "structured_result") return onStructuredResult(record, event);
    return handleEvent(record, event).pipe(Effect.asVoid);
  };
}

export type RunEventHandler = ReturnType<typeof makeRunEventHandler>;
