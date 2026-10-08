// Synthetic stream-input UUIDs are plain-crypto identity, not Effect resources.
import { synchronousRandomUuid } from "pi-cosmic-core";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import {
  makeLocalClaudeInputDelivery,
  userContentDigest,
  type PendingUserReplay,
} from "./local-claude-input-delivery.ts";
import * as Stream from "effect/Stream";
import type { LocalCliProcessHandle } from "../boundary/local-cli-process.ts";
import type { LocalClaudeDebugEntry } from "../boundary/local-claude-debug.ts";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type { SupervisorChannelHandle } from "../boundary/supervisor-channel.ts";
import { processError, type SubagentError } from "../run/errors.ts";
import type { SupervisorEvent } from "../supervisor/protocol.ts";
import { makeLocalCliInterrupts, type LocalCliInterrupt } from "./local-cli-interruption.ts";
import {
  toBackendExit,
  type BackendEvent,
  type BackendLaunchRequest,
  type BackendReport,
} from "./model.ts";
import {
  claudeLeadingTagDiagnostic,
  claudeOutboundAgeDiagnostic,
  claudeSessionDiagnostic,
  claudeTaskNotificationReplay,
  claudeTextLengthDiagnostic,
  isInternalReplayOrigin,
  isSameClaudeSession,
  makeClaudeResultCorrelation,
  uncorrelatedClaudeUserMessage,
  type ClaudeSentContentMatch,
  type ClaudeSentUserKind,
  type ClaudeUserDiagnosticContext,
  type ResultExpectation,
} from "./local-claude-correlation.ts";
import { makeLocalClaudeReportDelivery } from "./local-claude-report-delivery.ts";
import { makeLocalClaudeDiagnostics } from "./local-claude-diagnostics.ts";
import { makeLocalClaudeUsage, usageComponentsTotal } from "./local-claude-usage.ts";
import { makeLocalCliEventIngress } from "./local-cli-events.ts";
import { correlatedRequest, supervisorError } from "./driver-shared.ts";
import { deliverTerminalReport, makeLocalCliBackendDriver } from "./local-cli-driver.ts";
import { CLAUDE_NATIVE_AGENT_TOOLS } from "./claude-policy.ts";
import {
  CLAUDE_INTERRUPT_MARKER,
  claudeInitializeFrame,
  claudeInterruptFrame,
  claudeMcpStatusFrame,
  decodeClaudeInitializeControlResponse,
  decodeClaudeMcpStatusControlResponse,
  decodeClaudeProtocolEvent,
  type ClaudeControlRequestFrame,
  type ClaudeProtocolEvent,
} from "./local-claude-protocol.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";

const CONTROL_TIMEOUT = "10 seconds";
const MCP_READY_ATTEMPTS = 100;
const INITIALIZATION_PROBE = "pi-subagents native initialization probe";
const CLAUDE_NATIVE_AGENT_START_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const CLAUDE_NATIVE_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(CLAUDE_NATIVE_AGENT_TOOLS);

type ClaudeUserProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "user" }>;
type ClaudeInitProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "init" }>;
type ClaudeAssistantProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "assistant" }>;
type ClaudeResultProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "result" }>;
type ClaudeControlResponseEvent = Extract<
  ClaudeProtocolEvent,
  { readonly type: "control_response" }
>;
type UserDecision = Extract<LocalClaudeDebugEntry, { readonly kind: "user-decision" }>["decision"];

interface PendingControl {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

const sentKindForOperation = (operation: PendingUserReplay["operation"]): ClaudeSentUserKind =>
  operation === "initialize" ? "probe" : operation === "start" ? "assignment" : "steer";

/** Completed by the correlated replay marker plus aborted result pair. */
interface PendingInterrupt extends LocalCliInterrupt {
  readonly requestId: string;
  readonly response: Deferred.Deferred<unknown, SubagentError>;
  markerSeen: boolean;
  resultSeen: boolean;
}

const makeLocalClaudeHandle = Effect.fn("LocalClaudeBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliProcessHandle,
  supervisor: SupervisorChannelHandle,
) {
  const scope = yield* Scope.Scope;
  const { events, offer, release, acknowledge } = yield* makeLocalCliEventIngress(
    child.acknowledge,
  );
  const controlResponses = new Map<string, PendingControl>();
  const nativeInitialization = Deferred.makeUnsafe<ClaudeInitProtocolEvent, SubagentError>();
  const toolNames = new Map<string, string>();
  const nativeToolNames = new Map<string, string>();
  // Bounded identity of every confirmed outbound input so delayed or duplicate
  // replays of a known UUID stay nonfatal while unknown replays fail closed,
  // plus the owned result-expectation map/FIFO for exact result correlation.
  const correlation = makeClaudeResultCorrelation();
  const usage = makeLocalClaudeUsage();
  const reports = makeLocalClaudeReportDelivery(offer);
  let assignmentEpoch = 0;
  const interrupts = makeLocalCliInterrupts<PendingInterrupt>(
    "Claude",
    { offer, release },
    () => assignmentEpoch,
  );
  let nextControlId = 1;
  let initializationStarted = false;
  let nativeSessionId: string | undefined;
  let lastOutboundAtMillis: number | undefined;
  let wireSequence = 0;

  const recordDebug = child.claudeDebug?.record ?? ((_entry: LocalClaudeDebugEntry) => Effect.void);
  const nextWireSequence = (): number => {
    wireSequence += 1;
    return wireSequence;
  };

  const diagnostics = makeLocalClaudeDiagnostics(() => [
    ...toolNames.values(),
    ...nativeToolNames.values(),
  ]);
  const inputs = makeLocalClaudeInputDelivery(
    child,
    scope,
    (operation, epoch, shouldQuery) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMillis) => {
          lastOutboundAtMillis = nowMillis;
          return recordDebug({
            kind: "outbound-user",
            sequence: nextWireSequence(),
            operation,
            epoch,
            shouldQuery,
          });
        }),
      ),
    {
      onState: (input, state) =>
        offer({
          type: "input_delivery",
          assignmentEpoch: input.epoch,
          sequence: input.sequence,
          state,
        }),
      diagnose: diagnostics.diagnose,
      onFailure: (error) => offer({ type: "backend_failure", error }),
      preserveReport: (epoch): Effect.Effect<boolean> =>
        supervisor.acceptedReportForEpoch(epoch).pipe(
          Effect.flatMap((report) =>
            report?.assignmentEpoch === epoch
              ? forwardAcceptedReport(report).pipe(Effect.as(true))
              : Effect.succeed(false),
          ),
          Effect.orElseSucceed(() => false),
        ),
    },
  );
  /** Settles any guidance the accepted report outran, then forwards the report itself. */
  const forwardAcceptedReport = (report: BackendReport) =>
    inputs
      .acceptReport(report.assignmentEpoch)
      .pipe(Effect.andThen(reports.forwardReport({ type: "report", ...report })));

  const cancelPending = (error: SubagentError) => {
    inputs.cancel(error);
    for (const pending of controlResponses.values())
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    controlResponses.clear();
    Deferred.doneUnsafe(nativeInitialization, Effect.fail(error));
    interrupts.cancel(error);
    toolNames.clear();
    nativeToolNames.clear();
    correlation.clear();
    usage.clearMessageHistory();
    supervisor.cancelPending(error.message);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() =>
      cancelPending(
        processError("close", "local_claude_closed", "Local Claude Code backend closed."),
      ),
    ),
  );

  const handleSupervisorEvent = (event: SupervisorEvent) =>
    event.type === "report"
      ? inputs
          .acceptReport(event.assignmentEpoch)
          .pipe(
            Effect.flatMap((unconfirmed) =>
              unconfirmed ? reports.forwardReport(event) : reports.bufferAcceptedReport(event),
            ),
          )
      : offer(event);

  const handleToolResults = (
    toolResults: ClaudeUserProtocolEvent["toolResults"],
    raw: LocalCliWireEvent,
  ) =>
    Effect.gen(function* () {
      for (const [index, result] of toolResults.entries()) {
        // Native agent results surface as native activity; every other registered
        // tool finishes through the plain tool lifecycle.
        const nativeName = nativeToolNames.get(result.id);
        nativeToolNames.delete(result.id);
        const finished: BackendEvent = nativeName
          ? {
              type: "native_agent_activity",
              assignmentEpoch,
              activityId: result.id,
              kind: nativeName,
              state: result.isError ? "failed" : "completed",
            }
          : {
              type: "tool_finished",
              assignmentEpoch,
              toolCallId: result.id,
              toolName: toolNames.get(result.id) ?? "ClaudeTool",
              isError: result.isError,
            };
        if (!nativeName) toolNames.delete(result.id);
        // Only the final result of the frame carries the raw ownership budget.
        yield* offer(finished, index === toolResults.length - 1 ? raw : undefined);
      }
    });

  const onInit = (event: ClaudeInitProtocolEvent, raw: LocalCliWireEvent): Effect.Effect<void> => {
    nativeSessionId = event.sessionId;
    Deferred.doneUnsafe(nativeInitialization, Effect.succeed(event));
    return release(raw);
  };

  /** The event names the initialized native session, rather than merely not contradicting it. */
  const isExactSession = (event: ClaudeUserProtocolEvent): boolean =>
    event.sessionId !== undefined && event.sessionId === nativeSessionId;

  const isReplayConfirmation = (
    event: ClaudeUserProtocolEvent,
    pending: PendingUserReplay,
  ): boolean =>
    // Exact UUID correlation only; content identity is diagnostic evidence and
    // never authorizes a replay.
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
      // Only Claude's origin label rules out pending adapter input replayed without its UUID.
      (replay === "labelled" || inputs.pending === undefined) &&
      isExactSession(event) &&
      assignmentEpoch > 0 &&
      correlation.hasOutstandingAssignment(assignmentEpoch)
    );
  };

  const isSyntheticSubturn = (event: ClaudeUserProtocolEvent, sameSession: boolean): boolean =>
    (event.uuid === undefined ||
      (!correlation.hasSentUuid(event.uuid) && !correlation.hasInternalReplayUuid(event.uuid))) &&
    assignmentEpoch > 0 &&
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
    // A delayed or duplicate replay of an input this handle already
    // confirmed is safely acknowledged only inside the native session.
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
        uncorrelatedClaudeUserMessage(event, nativeSessionId, {
          sequence,
          contentMatch: contentMatch(event),
          pending: pendingDiagnostic(),
          report,
          sinceOutbound: claudeOutboundAgeDiagnostic(nowMillis, lastOutboundAtMillis),
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
        epoch: assignmentEpoch,
        replay: event.isReplay,
        synthetic: event.isSynthetic,
        meta: event.isMeta,
        compact: event.isCompactSummary,
        session: claudeSessionDiagnostic(event.sessionId, nativeSessionId),
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
    if (assignmentEpoch <= 0) return rejectUncorrelatedUser(event, raw, sequence, "none");
    return supervisor.acceptedReportForEpoch(assignmentEpoch).pipe(
      Effect.matchEffect({
        onFailure: () => rejectUncorrelatedUser(event, raw, sequence, "unknown"),
        onSuccess: (report) => {
          if (!report) return rejectUncorrelatedUser(event, raw, sequence, "none");
          // Completion evidence takes priority over the ordinary telemetry grace here: the
          // unexplained input requires prompt close-on-report settlement.
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

  /** Records one half of the interrupt evidence; the marker+result pair completes it. */
  const observeInterruptEvidence = (
    interrupt: PendingInterrupt,
    evidence: "markerSeen" | "resultSeen",
    raw: LocalCliWireEvent,
  ) =>
    Effect.suspend(() => {
      interrupt[evidence] = true;
      return interrupt.markerSeen && interrupt.resultSeen
        ? interrupts.complete(interrupt, raw)
        : release(raw);
    });

  const onUser = (event: ClaudeUserProtocolEvent, raw: LocalCliWireEvent, sequence: number) => {
    const sameSession = isSameClaudeSession(event.sessionId, nativeSessionId);
    const pending = inputs.pending;
    const interrupt = interrupts.current;
    const decide = (decision: UserDecision, action: Effect.Effect<void>) =>
      recordUserDecision(event, sequence, decision, "none").pipe(Effect.andThen(action));
    if (event.parentToolUseId !== undefined) {
      // --forward-subagent-text emits nested assistant/user frames with
      // parent_tool_use_id. Text-only user frames are activity, while their tool
      // results retain the nested tool lifecycle used by write-claim observation.
      if (assignmentEpoch <= 0 || !sameSession)
        return rejectUncorrelatedUser(event, raw, sequence, "none");
      return decide(
        "native-forward",
        event.toolResults.length > 0
          ? handleToolResults(event.toolResults, raw)
          : offer({ type: "activity", assignmentEpoch }, raw),
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
      return decide("interrupt-marker", observeInterruptEvidence(interrupt, "markerSeen", raw));
    if (isSyntheticSubturn(event, sameSession))
      return decide(
        isQueuedTaskNotificationReplay(event) ? "queued-task-notification" : "synthetic-subturn",
        Effect.suspend(() => {
          // Claude-owned task notifications and auto-continuations are
          // causal subturns of the active assignment. Older frames may omit
          // their UUID; command-queue replays omit the synthetic flag, and
          // 2.1.259 also omitted the origin. A private identity owns the
          // result FIFO.
          const syntheticUuid = event.uuid ?? `synthetic:${synchronousRandomUuid()}`;
          if (event.uuid !== undefined) correlation.rememberInternalReplayUuid(event.uuid);
          correlation.register(
            { uuid: syntheticUuid, kind: "synthetic", epoch: assignmentEpoch },
            usage.baseline(),
          );
          return offer({ type: "activity", assignmentEpoch }, raw);
        }),
      );
    if (isKnownInternalReplay(event, sameSession))
      return decide("known-internal-replay", release(raw));
    if (event.toolResults.length > 0)
      return decide("tool-results", handleToolResults(event.toolResults, raw));
    if (isKnownReplay(event)) return decide("known-replay", release(raw));
    return handleUncorrelatedTopLevelUser(event, raw, sequence);
  };

  const onControlResponse = (event: ClaudeControlResponseEvent, raw: LocalCliWireEvent) => {
    const pending = controlResponses.get(event.requestId);
    if (!pending) return release(raw);
    controlResponses.delete(event.requestId);
    Deferred.doneUnsafe(
      pending.deferred,
      event.success
        ? Effect.succeed(event.response)
        : Effect.fail(
            processError(
              pending.operation,
              `${pending.operation}_rejected`,
              event.diagnostic ?? `Claude Code rejected ${pending.operation}.`,
            ),
          ),
    );
    return release(raw);
  };

  const onAssistant = (event: ClaudeAssistantProtocolEvent, raw: LocalCliWireEvent) =>
    Effect.gen(function* () {
      for (const tool of event.tools) {
        if (CLAUDE_NATIVE_AGENT_TOOL_NAMES.has(tool.name)) {
          nativeToolNames.set(tool.id, tool.name);
          yield* offer({
            type: "native_agent_activity",
            assignmentEpoch,
            activityId: tool.id,
            kind: tool.name,
            state: CLAUDE_NATIVE_AGENT_START_TOOLS.has(tool.name) ? "running" : "completed",
          });
          continue;
        }
        toolNames.set(tool.id, tool.name);
        yield* offer({
          type: "tool_started",
          assignmentEpoch,
          toolCallId: tool.id,
          toolName: tool.name,
          args: tool.input,
        });
      }
      const { delta, inconsistent } = usage.assistantDelta(event.messageId, event.usage);
      if (inconsistent)
        yield* offer({
          type: "warning",
          message:
            "Claude reported a regressing cumulative assistant usage total; accounting stays monotone and the regression was ignored.",
        });
      yield* offer(
        {
          type: "assistant_message" as const,
          assignmentEpoch,
          ...(event.text !== undefined && event.text.length > 0 && { text: event.text }),
          usage: { ...delta, totalTokens: usageComponentsTotal(delta) },
        },
        raw,
      );
    });

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
    // total_cost_usd is cumulative within one native query, but each
    // result/query reports independently. Consume it once by UUID.
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
  ) => {
    // Assignment results may be acknowledged only after the MCP report
    // call recorded causal acceptance for the correlated epoch.
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
            onSuccess: (accepted) =>
              accepted
                ? release(raw).pipe(Effect.andThen(reports.observeNativeResult(completedEpoch)))
                : offer(
                    {
                      type: "protocol_error",
                      message:
                        "Claude Code result completed without an accepted supervisor report.",
                    },
                    raw,
                  ),
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
    // Only a causally correlated assignment result may use supervisor acceptance.
    // An unrelated, initialization, or foreign-session error remains fail-closed.
    const settleError =
      expectation?.kind === "assignment" &&
      expectation.epoch === assignmentEpoch &&
      isSameClaudeSession(event.sessionId, nativeSessionId)
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

  const onResult = (event: ClaudeResultProtocolEvent, raw: LocalCliWireEvent) => {
    // Correlate to the exact originating input: the native
    // user_message_uuid when reported, otherwise the owned issue-order
    // FIFO for a pinned protocol frame that legitimately omits it.
    const expectation = correlation.take(
      event.userMessageUuid,
      event.originKind,
      event.originSubkind,
    );
    // An interrupted assignment result: the exact native aborted-stream failure for
    // the pending interrupt's epoch (or an uncorrelated pinned frame), in this session.
    const interrupt = interrupts.current;
    const interruptedResult =
      interrupt !== undefined &&
      event.isError &&
      event.subtype === "error_during_execution" &&
      event.stopReason === "aborted_streaming" &&
      ((event.userMessageUuid === undefined && expectation === undefined) ||
        (expectation?.kind === "assignment" && expectation.epoch === interrupt.epoch)) &&
      isSameClaudeSession(event.sessionId, nativeSessionId);
    if (interruptedResult)
      return reconcileResultUsage(event, expectation).pipe(
        Effect.andThen(reports.observeNativeResult(interrupt.epoch)),
        Effect.andThen(observeInterruptEvidence(interrupt, "resultSeen", raw)),
      );
    if (event.isError) return handleResultError(event, expectation, raw);
    // The shouldQuery:false native initialization probe produces one
    // correlated result; it is an expected nonfatal artifact regardless
    // of any assignment epoch already in flight.
    if (expectation?.kind === "initialization") return release(raw);
    if (expectation?.kind === "synthetic")
      return reconcileResultUsage(event, expectation).pipe(Effect.andThen(release(raw)));
    if (expectation === undefined)
      return offer(
        {
          type: "protocol_error",
          message: "Claude Code emitted a result that no issued input correlates to.",
        },
        raw,
      );
    return confirmAssignmentResult(event, expectation, raw);
  };

  const consumeRaw = (raw: LocalCliWireEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      const sequence = nextWireSequence();
      if (raw.type === "protocol_error")
        return diagnostics
          .observe("protocol-error")
          .pipe(Effect.andThen(offer({ type: "protocol_error", message: raw.message }, raw)));
      return decodeClaudeProtocolEvent(raw.value).pipe(
        Effect.flatMap((event) => {
          const recordInbound =
            event.type === "activity" || event.type === "ignored"
              ? Effect.void
              : recordDebug({
                  kind: "inbound",
                  sequence,
                  protocolType: event.type,
                  epoch: assignmentEpoch,
                });
          return diagnostics
            .observe(event.type, event.type === "init" ? event.cliVersion : undefined)
            .pipe(
              Effect.andThen(recordInbound),
              Effect.andThen(
                (() => {
                  switch (event.type) {
                    case "ignored":
                      return release(raw);
                    case "init":
                      return onInit(event, raw);
                    case "activity":
                      return offer({ type: "activity", assignmentEpoch }, raw);
                    case "user":
                      return onUser(event, raw, sequence);
                    case "control_response":
                      return onControlResponse(event, raw);
                    case "assistant":
                      return onAssistant(event, raw);
                    case "result":
                      return onResult(event, raw);
                  }
                })(),
              ),
            );
        }),
        Effect.catch(() =>
          offer(
            { type: "protocol_error", message: "Claude Code emitted an invalid stream event." },
            raw,
          ),
        ),
      );
    });

  const preserveAcceptedReport = Effect.suspend(() =>
    assignmentEpoch <= 0
      ? Effect.void
      : supervisor.acceptedReportForEpoch(assignmentEpoch).pipe(
          Effect.flatMap((report) => (report ? forwardAcceptedReport(report) : Effect.void)),
          Effect.catch(() =>
            offer({
              type: "protocol_error",
              message:
                "Unable to preserve the accepted Claude report before the backend event transport closed.",
            }),
          ),
        ),
  );

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeRaw),
    Effect.ignoreCause,
    Effect.ensuring(
      deliverTerminalReport(
        events,
        preserveAcceptedReport.pipe(
          Effect.ensuring(
            Effect.sync(() =>
              cancelPending(
                processError(
                  "run",
                  "local_claude_transport_closed",
                  "Local Claude Code transport closed.",
                ),
              ),
            ),
          ),
        ),
        scope,
      ),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach(handleSupervisorEvent),
    Effect.ignoreCause,
    Effect.forkScoped,
  );

  const sendControl = (operation: string, frame: ClaudeControlRequestFrame) =>
    child
      .send(frame)
      .pipe(
        Effect.mapError((error) =>
          error.code === "transport_outcome_uncertain"
            ? processError(
                operation,
                `${operation}_outcome_uncertain`,
                `Claude ${operation} may already have applied; it will not be retried. (${error.message})`,
              )
            : error,
        ),
      );

  const requestControl = (
    operation: string,
    makeFrame: (requestId: string) => ClaudeControlRequestFrame,
  ): Effect.Effect<unknown, SubagentError> =>
    correlatedRequest({
      timeout: CONTROL_TIMEOUT,
      register: (deferred) => {
        const requestId = `${operation}-${nextControlId++}`;
        controlResponses.set(requestId, { operation, deferred });
        return {
          frame: makeFrame(requestId),
          unregister: Effect.sync(() => void controlResponses.delete(requestId)),
        };
      },
      send: (frame) => sendControl(operation, frame),
      timeoutError: () =>
        processError(
          operation,
          `${operation}_outcome_uncertain`,
          `Claude ${operation} was sent but no correlated native response arrived; it will not be retried.`,
        ),
    });

  const initialize = Effect.gen(function* () {
    if (initializationStarted)
      return yield* processError(
        "initialize",
        "claude_initialize_repeated",
        "Claude Code initialization may only be performed once per backend handle.",
      );
    initializationStarted = true;
    const response = yield* requestControl("initialize", claudeInitializeFrame);
    const advertised = yield* decodeClaudeInitializeControlResponse(response).pipe(
      Effect.mapError(() =>
        processError(
          "initialize",
          "claude_initialize_invalid",
          "Claude Code returned an invalid initialize control response.",
        ),
      ),
    );
    yield* inputs.send(INITIALIZATION_PROBE, 0, "initialize", false);
    const native = yield* Deferred.await(nativeInitialization).pipe(
      Effect.timeoutOrElse({
        duration: CONTROL_TIMEOUT,
        orElse: () =>
          Effect.fail(
            processError(
              "initialize",
              "claude_native_init_missing",
              "Claude Code did not emit its mandatory native system/init event.",
            ),
          ),
      }),
    );
    const resolvedModel =
      advertised.models.find((model) => model.value === request.model)?.resolvedModel ??
      request.model;
    if (native.model !== request.model && native.model !== resolvedModel)
      return yield* processError(
        "initialize",
        "claude_model_mismatch",
        `Claude Code selected model ${native.model} instead of required model ${request.model}.`,
      );
    if (native.cwd !== request.cwd)
      return yield* processError(
        "initialize",
        "claude_cwd_mismatch",
        "Claude Code initialized outside the canonical assigned working directory.",
      );
    if (!native.sessionId || native.hasMcpServerErrors)
      return yield* processError(
        "initialize",
        "claude_native_init_invalid",
        native.hasMcpServerErrors
          ? "Claude Code rejected part of the mandatory private MCP configuration."
          : "Claude Code did not provide a native session identity.",
      );

    for (let attempt = 0; attempt < MCP_READY_ATTEMPTS; attempt += 1) {
      const status = yield* requestControl("mcp_status", claudeMcpStatusFrame).pipe(
        Effect.flatMap((value) =>
          decodeClaudeMcpStatusControlResponse(value).pipe(
            Effect.mapError(() =>
              processError(
                "initialize",
                "claude_mcp_status_invalid",
                "Claude Code returned an invalid mandatory MCP status response.",
              ),
            ),
          ),
        ),
      );
      const server = status.mcpServers.find(
        (candidate) => candidate.name === SUPERVISOR_MCP_REGISTRATION,
      );
      if (server?.status === "connected") {
        const inventory = new Set(server.tools?.map((tool) => tool.name) ?? []);
        if (!SUPERVISOR_MCP_TOOL_NAMES.every((tool) => inventory.has(tool)))
          return yield* processError(
            "initialize",
            "claude_supervisor_tools_missing",
            "Claude Code connected the private supervisor MCP server without its mandatory tool inventory.",
          );
        return { model: native.model, effort: request.effort, sessionId: native.sessionId };
      }
      if (server && server.status !== "pending" && server.status !== "connecting") break;
      yield* Effect.sleep("50 millis");
    }
    return yield* processError(
      "initialize",
      "claude_supervisor_mcp_unavailable",
      "Claude Code did not connect the mandatory pi_subagents_supervisor MCP server.",
    );
  });

  const interrupt = interrupts.run({
    blocked: () =>
      inputs.pending || inputs.failure
        ? processError(
            "interrupt",
            "interrupt_not_sent",
            "Claude stream-input acknowledgement remains unresolved; cancel_queued interruption could discard owned guidance. Do not resend; wait or stop the run.",
          )
        : undefined,
    make: (base) => {
      const requestId = `interrupt-${nextControlId++}`;
      const response = Deferred.makeUnsafe<unknown, SubagentError>();
      controlResponses.set(requestId, { operation: "interrupt", deferred: response });
      return { ...base, requestId, response, markerSeen: false, resultSeen: false };
    },
    respond: (lifecycle) =>
      sendControl("interrupt", claudeInterruptFrame(lifecycle.requestId)).pipe(
        Effect.andThen(Deferred.await(lifecycle.response)),
      ),
    timeoutMessage:
      "Claude interrupt did not complete its correlated response, replay marker, and aborted result lifecycle; it will not be retried.",
    onRelease: (lifecycle) => controlResponses.delete(lifecycle.requestId),
  });

  return {
    pid: child.pid,
    events,
    awaitExit: child.awaitExit.pipe(
      Effect.map((exit) => ({
        ...toBackendExit(exit),
        ...(inputs.failure && { failure: inputs.failure }),
      })),
      Effect.mapError((error) => inputs.failure ?? error),
    ),
    controls: {
      initialize,
      start: (message: string, epoch: number) =>
        supervisor.setAssignmentEpoch(epoch).pipe(
          Effect.mapError(supervisorError("start")),
          Effect.andThen(
            Effect.sync(() => {
              assignmentEpoch = epoch;
            }),
          ),
          Effect.andThen(inputs.send(message, epoch, "start")),
        ),
      steer: (message: string) => inputs.send(message, assignmentEpoch, "steer"),
      interrupt,
    },
    acknowledge,
    terminate: child.terminate,
    cancelPending,
  };
});

export const makeLocalClaudeBackendDriver = makeLocalCliBackendDriver(
  "claude",
  (capability) => `Local Claude Code does not provide a confirmable ${capability} operation.`,
  makeLocalClaudeHandle,
);
