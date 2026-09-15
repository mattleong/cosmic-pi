import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { BackendEvent, BackendReport } from "../backend/model.ts";
import type { SubagentNotification } from "../boundary/host-notifier.ts";
import type { SubagentError } from "./errors.ts";
import { SubagentProcessError, SubagentProtocolError } from "./errors.ts";
import { isInactiveRunRecord, type RunRecord } from "./internal.ts";
import type { SubagentRunView } from "./model.ts";
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
import { projectRunWarning, setRunWarning } from "./warnings.ts";

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
  /** Starts asynchronous containment after an unambiguous native file-tool violation. */
  readonly onWriteClaimViolation: (record: RunRecord, message: string) => Effect.Effect<void>;
  readonly onProxyEvent: (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "proxy_request" | "proxy_cancel" }>,
  ) => Effect.Effect<void>;
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
    onWriteClaimViolation,
    onProxyEvent,
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
            ...projectRunWarning(record.warningSlots, "child"),
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

  const handleInactiveEvent = (record: RunRecord, event: BackendEvent): Effect.Effect<void> => {
    // A backend may report final cumulative usage/cost only at its native result, after the
    // accepted report settled the run. That exact epoch's usage still merges into the outcome.
    if (event.type === "assistant_message")
      return mergeLateUsage(record, event.assignmentEpoch, event.usage);
    return Effect.void;
  };

  const handleAssistantMessage = (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "assistant_message" }>,
  ): Effect.Effect<void> => {
    const latestAssistantText = event.text
      ? sanitizeOutputText(event.text, MAX_FINAL_TEXT_CHARS)
      : undefined;
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        mutateView(record, event.assignmentEpoch, (current) => {
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
        }),
      ),
      Effect.asVoid,
    );
  };

  const handleExit = (
    record: RunRecord,
    event: Extract<BackendEvent, { readonly type: "exit" }>,
  ): Effect.Effect<void> => {
    const processFailure = new SubagentProcessError({
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
      : settle(record, "failed", processFailure.message).pipe(Effect.asVoid);
  };

  return (record: RunRecord, event: BackendEvent): Effect.Effect<void, SubagentError> => {
    if (event.type === "proxy_request" || event.type === "proxy_cancel")
      return onProxyEvent(record, event);
    if (event.type !== "exit" && isInactiveRunRecord(record))
      return handleInactiveEvent(record, event);
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
      case "native_agent_activity":
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            mutateView(record, event.assignmentEpoch, (current) => {
              const activityId = sanitizeDiagnosticText(event.activityId, 256);
              const kind = sanitizeDiagnosticText(event.kind, 128);
              if (event.state === "running") {
                if (!record.nativeAgents.has(activityId) && record.nativeAgents.size < 64) {
                  record.nativeAgents.set(activityId, { kind });
                  record.nativeAgentTotal = Math.min(
                    Number.MAX_SAFE_INTEGER,
                    record.nativeAgentTotal + 1,
                  );
                }
              } else if (event.state !== "activity") record.nativeAgents.delete(activityId);
              return {
                ...current,
                lastActivityAt: now,
                nativeActivity: {
                  active: record.nativeAgents.size,
                  total: record.nativeAgentTotal,
                  latest: {
                    id: activityId,
                    kind,
                    state: event.state,
                    updatedAt: now,
                  },
                },
              };
            }),
          ),
          Effect.asVoid,
        );
      case "assistant_message":
        return handleAssistantMessage(record, event);
      case "tool_started":
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => {
            const observed = observeFileWrite(event.toolName, event.args);
            const observedPaths = observed
              ? observed.paths.length > 0
                ? observed.paths.map((path) => ({
                    relative: workspaceRelativeObservedPath(record.view.cwd, path),
                  }))
                : [{ relative: undefined }]
              : [];
            const violatingPaths =
              record.view.writeClaims === undefined
                ? []
                : observedPaths.filter(
                    ({ relative }) =>
                      relative === undefined ||
                      !writeClaimContains(record.view.writeClaims ?? [], relative),
                  );
            const bashHint = bashCommandMayMutate(event.toolName, event.args);
            const violationMessage =
              violatingPaths.length > 0
                ? `Writer ${record.view.id} used ${event.toolName} outside its cooperative claims: ${violatingPaths
                    .map(({ relative }) => relative ?? OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER)
                    .join(", ")}. Containment has started, and new writer admission is paused.`
                : undefined;
            return mutateView(record, event.assignmentEpoch, (current) => {
              if (current.state === "paused") return undefined;
              record.activeTools.set(event.toolCallId, event.toolName);
              const writeAudit = current.writeAudit
                ? {
                    observedFileWrites: [
                      ...new Set([
                        ...current.writeAudit.observedFileWrites,
                        ...observedPaths.map(
                          ({ relative }) => relative ?? OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
                        ),
                      ]),
                    ].slice(-MAX_OBSERVED_WRITE_PATHS),
                    violations: [
                      ...current.writeAudit.violations,
                      ...violatingPaths.map(({ relative }) => ({
                        path: relative ?? OUTSIDE_WORKSPACE_WRITE_CLAIM_MARKER,
                        toolName: event.toolName,
                        observedAt: now,
                      })),
                    ].slice(-MAX_WRITE_CLAIM_VIOLATIONS),
                    bashWriteHints: Math.min(
                      Number.MAX_SAFE_INTEGER,
                      current.writeAudit.bashWriteHints + (bashHint ? 1 : 0),
                    ),
                  }
                : undefined;
              const warning = violationMessage;
              if (warning)
                record.warningSlots = setRunWarning(record.warningSlots, "system", warning);
              const sessionEvents = startToolSessionEvent(current.sessionEvents, {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                args: event.args,
                startedAt: now,
              });
              return {
                ...current,
                ...(writeAudit && { writeAudit }),
                ...(warning
                  ? {
                      ...projectRunWarning(record.warningSlots, "system"),
                      sessionEvents: appendNoticeSessionEvent(
                        sessionEvents,
                        "warning",
                        warning,
                        now,
                      ),
                    }
                  : { sessionEvents }),
                currentTool: [...record.activeTools.values()].at(-1),
                lastActivityAt: now,
              };
            }).pipe(
              Effect.flatMap((updated) =>
                updated && violationMessage
                  ? onWriteClaimViolation(record, violationMessage)
                  : Effect.void,
              ),
            );
          }),
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
                ...projectRunWarning(record.warningSlots, "system"),
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
      case "exit":
        return handleExit(record, event);
    }
  };
}
