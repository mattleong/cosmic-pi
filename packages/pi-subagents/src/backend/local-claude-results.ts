import * as Effect from "effect/Effect";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import { observeInterruptEvidence, type LocalClaudeHandleContext } from "./local-claude-context.ts";
import {
  isInternalReplayOrigin,
  isSameClaudeSession,
  type ResultExpectation,
} from "./local-claude-correlation.ts";
import type { ClaudeProtocolEvent } from "./local-claude-protocol.ts";
import { usageComponentsTotal } from "./local-claude-usage.ts";

type ClaudeResultProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "result" }>;

const CONTINUATION_GRACE = "20 seconds";

export const localClaudeResults = (context: LocalClaudeHandleContext) => {
  const {
    state,
    supervisor,
    offer,
    release,
    correlation,
    usage,
    reports,
    interrupts,
    forwardAcceptedReport,
    forkOwned,
  } = context;

  const missingReport = (raw?: LocalCliWireEvent) =>
    offer(
      {
        type: "protocol_error",
        message: "Claude Code result completed without an accepted supervisor report.",
      },
      raw,
    );

  // Claude starts the continuation right after the turn that received the notification ends;
  // without any main-session output by then, the notification was absorbed and no report comes.
  const continuationWatchdog = (epoch: number, token: number) =>
    Effect.sleep(CONTINUATION_GRACE).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          if (
            state.awaitingContinuationEpoch !== epoch ||
            state.continuationToken !== token ||
            state.continuationActivity ||
            state.backgroundTasks > 0
          )
            return Effect.void;
          state.awaitingContinuationEpoch = undefined;
          return missingReport();
        }),
      ),
    );

  const reconcileResultUsage = (
    event: ClaudeResultProtocolEvent,
    expectation: ResultExpectation | undefined,
  ): Effect.Effect<void> => {
    if (
      expectation === undefined ||
      expectation.kind === "initialization" ||
      (event.usage === undefined && event.totalCostUsd === undefined)
    )
      return Effect.void;
    const { delta, inconsistent } = usage.resultDelta(expectation.usageBaseline, event.usage);
    const costDelta = event.totalCostUsd;
    const warn = inconsistent
      ? offer({
          type: "warning",
          message:
            "Claude reported a regressing cumulative result usage total; accounting stays monotone and the regression was ignored.",
        })
      : Effect.void;
    const emit =
      usageComponentsTotal(delta) > 0 || costDelta !== undefined
        ? offer({
            type: "assistant_message",
            assignmentEpoch: expectation.epoch,
            usage: {
              ...delta,
              totalTokens: usageComponentsTotal(delta),
              ...(costDelta !== undefined && { cost: costDelta }),
            },
          })
        : Effect.void;
    return warn.pipe(Effect.andThen(emit));
  };

  const confirmAssignmentResult = (
    event: ClaudeResultProtocolEvent,
    expectation: ResultExpectation,
    raw: LocalCliWireEvent,
    notified: boolean,
  ) => {
    const completedEpoch = expectation.epoch;
    return reconcileResultUsage(event, expectation).pipe(
      Effect.andThen(
        supervisor.hasAcceptedReport(completedEpoch).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              offer(
                {
                  type: "protocol_error",
                  message: `Unable to confirm Claude supervisor report ownership: ${error.message}`,
                },
                raw,
              ),
            onSuccess: (accepted) => {
              if (accepted) {
                state.awaitingContinuationEpoch = undefined;
                return release(raw).pipe(
                  Effect.andThen(reports.observeNativeResult(completedEpoch)),
                );
              }
              // Claude resumes in a new turn when its background work reports back; the report
              // is due from that continuation, not from the turn that started the work.
              if (state.backgroundTasks > 0 || notified) {
                state.awaitingContinuationEpoch = completedEpoch;
                state.continuationActivity = false;
                const token = ++state.continuationToken;
                return release(raw).pipe(
                  Effect.andThen(
                    state.backgroundTasks > 0
                      ? Effect.void
                      : forkOwned(continuationWatchdog(completedEpoch, token)),
                  ),
                );
              }
              state.awaitingContinuationEpoch = undefined;
              return missingReport(raw);
            },
          }),
        ),
      ),
    );
  };

  const handleResultError = (
    event: ClaudeResultProtocolEvent,
    expectation: ResultExpectation | undefined,
    raw: LocalCliWireEvent,
  ) => {
    const reject = offer(
      {
        type: "protocol_error" as const,
        message: event.diagnostic
          ? `Claude Code result failed: ${event.diagnostic}`
          : "Claude Code result failed before a supervisor report was accepted.",
      },
      raw,
    );
    const settleError =
      expectation?.kind === "assignment" &&
      expectation.epoch === state.assignmentEpoch &&
      isSameClaudeSession(event.sessionId, state.nativeSessionId)
        ? supervisor.acceptedReportForEpoch(expectation.epoch).pipe(
            Effect.matchEffect({
              onFailure: () => reject,
              onSuccess: (report) =>
                report?.assignmentEpoch === expectation.epoch
                  ? offer(
                      {
                        type: "warning",
                        message:
                          "Claude emitted a native result error after exact supervisor report acceptance; the accepted report was preserved.",
                      },
                      raw,
                    ).pipe(Effect.andThen(forwardAcceptedReport(report)))
                  : reject,
            }),
          )
        : reject;
    return reconcileResultUsage(event, expectation).pipe(Effect.andThen(settleError));
  };

  const isInterruptedResult = (
    event: ClaudeResultProtocolEvent,
    expectation: ReturnType<typeof correlation.take>,
    interruptEpoch: number,
  ): boolean =>
    event.isError &&
    event.subtype === "error_during_execution" &&
    event.stopReason === "aborted_streaming" &&
    ((event.userMessageUuid === undefined && expectation === undefined) ||
      (expectation?.kind === "assignment" && expectation.epoch === interruptEpoch)) &&
    isSameClaudeSession(event.sessionId, state.nativeSessionId);

  const onResult = (event: ClaudeResultProtocolEvent, raw: LocalCliWireEvent) => {
    if (!isSameClaudeSession(event.sessionId, state.nativeSessionId))
      return offer(
        {
          type: "protocol_error",
          message: "Claude Code emitted a result from a different native session.",
        },
        raw,
      );
    const expectation = correlation.take(
      event.userMessageUuid,
      event.originKind,
      event.originSubkind,
    );
    const notified = state.notificationSinceResult;
    state.notificationSinceResult = false;
    const interrupt = interrupts.current;
    if (interrupt !== undefined && isInterruptedResult(event, expectation, interrupt.epoch))
      return reconcileResultUsage(event, expectation).pipe(
        Effect.andThen(reports.observeNativeResult(interrupt.epoch)),
        Effect.andThen(observeInterruptEvidence(context, interrupt, "resultSeen", raw)),
      );
    if (event.isError) return handleResultError(event, expectation, raw);
    if (expectation?.kind === "initialization") return release(raw);
    if (expectation?.kind === "synthetic")
      return expectation.epoch === state.awaitingContinuationEpoch &&
        expectation.epoch === state.assignmentEpoch
        ? confirmAssignmentResult(event, expectation, raw, notified)
        : reconcileResultUsage(event, expectation).pipe(Effect.andThen(release(raw)));
    // Claude starts the continuation turn from its own task notification without replaying it as
    // user input, so nothing correlates the result; while one is awaited, it is that continuation.
    if (expectation === undefined && state.awaitingContinuationEpoch === state.assignmentEpoch)
      return confirmAssignmentResult(
        event,
        {
          uuid: `continuation:${state.assignmentEpoch}`,
          kind: "synthetic",
          epoch: state.assignmentEpoch,
          usageBaseline: usage.baseline(),
        },
        raw,
        notified,
      );
    // After the assignment settles, Claude may still take a turn to absorb its own background
    // work's notification; that turn reports nothing and only its usage counts.
    if (
      expectation === undefined &&
      (notified ||
        (event.userMessageUuid === undefined &&
          isInternalReplayOrigin(event.originKind, event.originSubkind))) &&
      state.assignmentEpoch > 0 &&
      !correlation.hasOutstandingAssignment(state.assignmentEpoch)
    )
      return reconcileResultUsage(event, {
        uuid: `settled:${state.assignmentEpoch}`,
        kind: "synthetic",
        epoch: state.assignmentEpoch,
        usageBaseline: usage.baseline(),
      }).pipe(Effect.andThen(release(raw)));
    if (expectation === undefined)
      return offer(
        {
          type: "protocol_error",
          message: "Claude Code emitted a result that no issued input correlates to.",
        },
        raw,
      );
    return confirmAssignmentResult(event, expectation, raw, notified);
  };

  // Once the last background task finishes, its notification should start the continuation soon.
  const onBackgroundTasksSettled = (): Effect.Effect<void> => {
    const epoch = state.awaitingContinuationEpoch;
    if (epoch === undefined || epoch !== state.assignmentEpoch) return Effect.void;
    state.continuationActivity = false;
    return forkOwned(continuationWatchdog(epoch, ++state.continuationToken));
  };

  return { onResult, onBackgroundTasksSettled };
};
