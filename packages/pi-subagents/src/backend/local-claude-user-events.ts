import { synchronousRandomUuid } from "pi-cosmic-core";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { LocalClaudeDebugEntry } from "../boundary/local-claude-debug.ts";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import {
  observeInterruptEvidence,
  type ClaudeUserProtocolEvent,
  type LocalClaudeHandleContext,
} from "./local-claude-context.ts";
import {
  claudeLeadingTagDiagnostic,
  claudeOutboundAgeDiagnostic,
  claudeSessionDiagnostic,
  claudeTaskNotificationReplay,
  claudeTextLengthDiagnostic,
  isInternalReplayOrigin,
  isSameClaudeSession,
  uncorrelatedClaudeUserMessage,
  type ClaudeSentContentMatch,
  type ClaudeSentUserKind,
  type ClaudeUserDiagnosticContext,
} from "./local-claude-correlation.ts";
import { userContentDigest, type PendingUserReplay } from "./local-claude-input-delivery.ts";
import { CLAUDE_INTERRUPT_MARKER } from "./local-claude-protocol.ts";
import type { BackendEvent } from "./model.ts";

type UserDecision = Extract<LocalClaudeDebugEntry, { readonly kind: "user-decision" }>["decision"];

const sentKindForOperation = (operation: PendingUserReplay["operation"]): ClaudeSentUserKind =>
  operation === "initialize" ? "probe" : operation === "start" ? "assignment" : "steer";

export const makeLocalClaudeUserEvents = (context: LocalClaudeHandleContext) => {
  const {
    state,
    child,
    supervisor,
    offer,
    release,
    correlation,
    usage,
    interrupts,
    inputs,
    recordDebug,
    forwardAcceptedReport,
    toolNames,
    nativeToolNames,
  } = context;

  const handleToolResults = (
    toolResults: ClaudeUserProtocolEvent["toolResults"],
    raw: LocalCliWireEvent,
  ) =>
    Effect.gen(function* () {
      for (const [index, result] of toolResults.entries()) {
        const nativeName = nativeToolNames.get(result.id);
        nativeToolNames.delete(result.id);
        const finished: BackendEvent = nativeName
          ? {
              type: "native_agent_activity",
              assignmentEpoch: state.assignmentEpoch,
              activityId: result.id,
              kind: nativeName,
              state: result.isError ? "failed" : "completed",
            }
          : {
              type: "tool_finished",
              assignmentEpoch: state.assignmentEpoch,
              toolCallId: result.id,
              toolName: toolNames.get(result.id) ?? "ClaudeTool",
              isError: result.isError,
            };
        if (!nativeName) toolNames.delete(result.id);
        yield* offer(finished, index === toolResults.length - 1 ? raw : undefined);
      }
    });

  const isExactSession = (event: ClaudeUserProtocolEvent): boolean =>
    event.sessionId !== undefined && event.sessionId === state.nativeSessionId;

  const isReplayConfirmation = (
    event: ClaudeUserProtocolEvent,
    pending: PendingUserReplay,
  ): boolean =>
    event.isReplay &&
    event.uuid !== undefined &&
    event.uuid === pending.uuid &&
    isExactSession(event);

  const isInterruptMarker = (event: ClaudeUserProtocolEvent, sameSession: boolean): boolean =>
    event.isReplay &&
    event.text === CLAUDE_INTERRUPT_MARKER &&
    event.toolResults.length === 0 &&
    event.uuid === undefined &&
    sameSession;

  const isQueuedTaskNotificationReplay = (event: ClaudeUserProtocolEvent): boolean => {
    const replay = claudeTaskNotificationReplay(event);
    return (
      replay !== undefined &&
      (replay === "labelled" || inputs.pending === undefined) &&
      isExactSession(event) &&
      state.assignmentEpoch > 0 &&
      correlation.hasOutstandingAssignment(state.assignmentEpoch)
    );
  };

  const isSyntheticSubturn = (event: ClaudeUserProtocolEvent, sameSession: boolean): boolean =>
    (event.uuid === undefined ||
      (!correlation.hasSentUuid(event.uuid) && !correlation.hasInternalReplayUuid(event.uuid))) &&
    state.assignmentEpoch > 0 &&
    sameSession &&
    ((event.isSynthetic && isInternalReplayOrigin(event.originKind, event.originSubkind)) ||
      isQueuedTaskNotificationReplay(event));

  const isKnownInternalReplay = (event: ClaudeUserProtocolEvent, sameSession: boolean): boolean =>
    event.uuid !== undefined &&
    correlation.hasInternalReplayUuid(event.uuid) &&
    sameSession &&
    ((event.isSynthetic && isInternalReplayOrigin(event.originKind, event.originSubkind)) ||
      claudeTaskNotificationReplay(event) !== undefined);

  const isKnownReplay = (event: ClaudeUserProtocolEvent): boolean =>
    event.uuid !== undefined &&
    correlation.hasSentUuid(event.uuid) &&
    (event.isReplay || isInternalReplayOrigin(event.originKind, event.originSubkind)) &&
    isExactSession(event);

  const pendingDiagnostic = (): ClaudeUserDiagnosticContext["pending"] =>
    inputs.pending?.operation ?? (interrupts.current ? "interrupt" : "none");

  const contentMatch = (event: ClaudeUserProtocolEvent): ClaudeSentContentMatch => {
    const digest = userContentDigest(event.text);
    const pending = inputs.pending;
    return pending?.contentDigest === digest
      ? sentKindForOperation(pending.operation)
      : correlation.matchSentContent(digest);
  };

  const uncorrelatedMessage = (
    event: ClaudeUserProtocolEvent,
    sequence: number,
    report: ClaudeUserDiagnosticContext["report"],
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((nowMillis) =>
        uncorrelatedClaudeUserMessage(event, state.nativeSessionId, {
          sequence,
          contentMatch: contentMatch(event),
          pending: pendingDiagnostic(),
          report,
          sinceOutbound: claudeOutboundAgeDiagnostic(nowMillis, state.lastOutboundAtMillis),
          traceEnabled: child.claudeDebug !== undefined,
        }),
      ),
    );

  const recordUserDecision = (
    event: ClaudeUserProtocolEvent,
    sequence: number,
    decision: UserDecision,
    report: ClaudeUserDiagnosticContext["report"],
  ) => {
    if (!child.claudeDebug) return Effect.void;
    return Effect.suspend(() => {
      const pending = inputs.pending;
      const uuid =
        event.uuid === undefined
          ? "absent"
          : pending?.uuid === event.uuid
            ? "pending"
            : correlation.hasSentUuid(event.uuid)
              ? "known"
              : correlation.hasInternalReplayUuid(event.uuid)
                ? "internal"
                : "unknown";
      return recordDebug({
        kind: "user-decision",
        sequence,
        decision,
        epoch: state.assignmentEpoch,
        replay: event.isReplay,
        synthetic: event.isSynthetic,
        meta: event.isMeta,
        compact: event.isCompactSummary,
        session: claudeSessionDiagnostic(event.sessionId, state.nativeSessionId),
        uuid,
        content: contentMatch(event),
        contentForm: event.contentKind,
        length: claudeTextLengthDiagnostic(event.textLength),
        tag: claudeLeadingTagDiagnostic(event.text),
        parentTool: event.parentToolUseId !== undefined,
        toolResults: event.toolResults.length > 0,
        origin: event.originKind !== undefined,
        subkind: event.originSubkind !== undefined,
        pending: pendingDiagnostic(),
        report,
      });
    }).pipe(Effect.ignoreCause);
  };

  const rejectUncorrelatedUser = (
    event: ClaudeUserProtocolEvent,
    raw: LocalCliWireEvent,
    sequence: number,
    report: "none" | "unknown",
  ) =>
    uncorrelatedMessage(event, sequence, report).pipe(
      Effect.flatMap((message) =>
        recordUserDecision(event, sequence, "unknown-before-report", report).pipe(
          Effect.andThen(offer({ type: "protocol_error", message }, raw)),
        ),
      ),
    );

  const handleUncorrelatedTopLevelUser = (
    event: ClaudeUserProtocolEvent,
    raw: LocalCliWireEvent,
    sequence: number,
  ) => {
    if (state.assignmentEpoch <= 0) return rejectUncorrelatedUser(event, raw, sequence, "none");
    return supervisor.acceptedReportForEpoch(state.assignmentEpoch).pipe(
      Effect.matchEffect({
        onFailure: () => rejectUncorrelatedUser(event, raw, sequence, "unknown"),
        onSuccess: (report) => {
          if (!report) return rejectUncorrelatedUser(event, raw, sequence, "none");
          return uncorrelatedMessage(event, sequence, "accepted").pipe(
            Effect.flatMap((message) =>
              recordUserDecision(event, sequence, "unknown-after-report", "accepted").pipe(
                Effect.andThen(
                  offer(
                    {
                      type: "warning",
                      message: `${message} The accepted supervisor report was preserved.`,
                    },
                    raw,
                  ),
                ),
                Effect.andThen(forwardAcceptedReport(report)),
              ),
            ),
          );
        },
      }),
    );
  };

  const onUser = (event: ClaudeUserProtocolEvent, raw: LocalCliWireEvent, sequence: number) => {
    const sameSession = isSameClaudeSession(event.sessionId, state.nativeSessionId);
    const pending = inputs.pending;
    const interrupt = interrupts.current;
    const decide = (decision: UserDecision, action: Effect.Effect<void>) =>
      recordUserDecision(event, sequence, decision, "none").pipe(Effect.andThen(action));
    if (event.parentToolUseId !== undefined) {
      if (state.assignmentEpoch <= 0 || !sameSession)
        return rejectUncorrelatedUser(event, raw, sequence, "none");
      return decide(
        "native-forward",
        event.toolResults.length > 0
          ? handleToolResults(event.toolResults, raw)
          : offer({ type: "activity", assignmentEpoch: state.assignmentEpoch }, raw),
      );
    }
    if (pending && isReplayConfirmation(event, pending)) {
      return decide(
        "pending-confirmation",
        Effect.suspend(() => {
          if (inputs.pending !== pending || inputs.failure) return release(raw);
          correlation.rememberSentUuid(pending.uuid, {
            contentDigest: pending.contentDigest,
            kind: sentKindForOperation(pending.operation),
          });
          if (pending.resultKind)
            correlation.register(
              { uuid: pending.uuid, kind: pending.resultKind, epoch: pending.epoch },
              usage.baseline(),
            );
          return inputs
            .confirm(pending)
            .pipe(
              Effect.andThen(
                pending.emitRunStarted
                  ? offer({ type: "run_started", assignmentEpoch: pending.epoch }, raw)
                  : release(raw),
              ),
            );
        }),
      );
    }
    if (interrupt && isInterruptMarker(event, sameSession))
      return decide(
        "interrupt-marker",
        observeInterruptEvidence(context, interrupt, "markerSeen", raw),
      );
    if (isSyntheticSubturn(event, sameSession))
      return decide(
        isQueuedTaskNotificationReplay(event) ? "queued-task-notification" : "synthetic-subturn",
        Effect.suspend(() => {
          const syntheticUuid = event.uuid ?? `synthetic:${synchronousRandomUuid()}`;
          if (event.uuid !== undefined) correlation.rememberInternalReplayUuid(event.uuid);
          correlation.register(
            { uuid: syntheticUuid, kind: "synthetic", epoch: state.assignmentEpoch },
            usage.baseline(),
          );
          return offer({ type: "activity", assignmentEpoch: state.assignmentEpoch }, raw);
        }),
      );
    if (isKnownInternalReplay(event, sameSession))
      return decide("known-internal-replay", release(raw));
    if (event.toolResults.length > 0)
      return decide("tool-results", handleToolResults(event.toolResults, raw));
    if (isKnownReplay(event)) return decide("known-replay", release(raw));
    return handleUncorrelatedTopLevelUser(event, raw, sequence);
  };

  return { onUser };
};
