// Stream-input UUIDs and content digests are plain-crypto identity, not Effect resources.
import { createHash, randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type {
  LocalCliProcessContract,
  LocalCliProcessHandle,
} from "../boundary/local-cli-process.ts";
import type { LocalClaudeDebugEntry } from "../boundary/local-claude-debug.ts";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type {
  SupervisorChannelHandle,
  SupervisorChannelContract,
} from "../boundary/supervisor-channel.ts";
import {
  isOutcomeUncertain,
  processError,
  SubagentProcessError,
  type SubagentError,
} from "../run/errors.ts";
import type { SupervisorEvent } from "../supervisor/protocol.ts";
import { classifyLocalCliInterruptOwnership } from "./local-cli-interruption.ts";
import {
  toBackendExit,
  type BackendDriver,
  type BackendEvent,
  type BackendLaunchRequest,
} from "./model.ts";
import {
  claudeLeadingTagDiagnostic,
  claudeOutboundAgeDiagnostic,
  claudeSessionDiagnostic,
  claudeTextLengthDiagnostic,
  isClaudeQueuedTaskNotificationReplay,
  isInternalReplayOrigin,
  isSameClaudeSession,
  makeClaudeResultCorrelation,
  uncorrelatedClaudeUserMessage,
  usageComponentsTotal,
  type ClaudeSentContentMatch,
  type ClaudeSentUserKind,
  type ClaudeUserDiagnosticContext,
  type ResultExpectation,
} from "./local-claude-correlation.ts";
import { makeLocalClaudeReportDelivery } from "./local-claude-report-delivery.ts";
import { makeLocalClaudeUsage } from "./local-claude-usage.ts";
import { makeLocalCliRawEventOwnership } from "./local-cli-events.ts";
import { correlatedRequest, unsupported as unsupportedCapability } from "./driver-shared.ts";
import { withLocalSupervisorInstructions } from "./local-supervisor-prompt.ts";
import {
  CLAUDE_INTERRUPT_MARKER,
  claudeInitializeFrame,
  claudeInterruptFrame,
  claudeMcpStatusFrame,
  claudeUserFrame,
  decodeClaudeInitializeControlResponse,
  decodeClaudeMcpStatusControlResponse,
  decodeClaudeProtocolEvent,
  type ClaudeControlRequestFrame,
  type ClaudeNativeInitialization,
  type ClaudeProtocolEvent,
} from "./local-claude-protocol.ts";
import {
  SUPERVISOR_MCP_REGISTRATION,
  SUPERVISOR_MCP_TOOL_NAMES,
} from "../supervisor/mcp-contract.ts";

const EVENT_CAPACITY = 512;
const CONTROL_TIMEOUT = "10 seconds";
const MCP_READY_ATTEMPTS = 100;
const INITIALIZATION_PROBE = "pi-subagents native initialization probe";
const CLAUDE_NATIVE_AGENT_START_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const CLAUDE_NATIVE_AGENT_TOOLS: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "TaskOutput",
  "TaskStop",
  "SendMessage",
]);

type ClaudeUserProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "user" }>;
type ClaudeInitProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "init" }>;
type ClaudeAssistantProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "assistant" }>;
type ClaudeResultProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "result" }>;
type ClaudeControlResponseEvent = Extract<
  ClaudeProtocolEvent,
  { readonly type: "control_response" }
>;

const unsupported = (capability: string) =>
  unsupportedCapability(
    "local/claude",
    capability,
    `Local Claude Code does not provide a confirmable ${capability} operation.`,
  );

interface PendingUserReplay {
  readonly uuid: string;
  readonly operation: "initialize" | "start" | "steer";
  readonly contentDigest: string;
  readonly epoch: number;
  readonly emitRunStarted: boolean;
  readonly resultKind: "initialization" | "assignment" | undefined;
  readonly acknowledgement: Deferred.Deferred<void, SubagentError>;
}

interface PendingControl {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

const userContentDigest = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const sentKindForOperation = (operation: PendingUserReplay["operation"]): ClaudeSentUserKind =>
  operation === "initialize" ? "probe" : operation === "start" ? "assignment" : "steer";

interface PendingInterrupt {
  readonly requestId: string;
  readonly epoch: number;
  readonly response: Deferred.Deferred<unknown, SubagentError>;
  readonly terminal: Deferred.Deferred<void, SubagentError>;
  markerSeen: boolean;
  resultSeen: boolean;
  /**
   * Set when the public interrupt call timed out with an uncertain outcome. The
   * lifecycle then remains exactly owned: a late correlated marker+result pair
   * settles the assignment through `run_settled` instead of a protocol error.
   */
  abandoned: boolean;
}

const makeLocalClaudeHandle = Effect.fn("LocalClaudeBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliProcessHandle,
  supervisor: SupervisorChannelHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const { offer, release, acknowledge, acknowledgeAll } = makeLocalCliRawEventOwnership(
    events,
    child.acknowledge,
  );
  const controlResponses = new Map<string, PendingControl>();
  const nativeInitialization = Deferred.makeUnsafe<ClaudeNativeInitialization, SubagentError>();
  const toolNames = new Map<string, string>();
  const nativeToolNames = new Map<string, string>();
  // Bounded identity of every confirmed outbound input so delayed or duplicate
  // replays of a known UUID stay nonfatal while unknown replays fail closed,
  // plus the owned result-expectation map/FIFO for exact result correlation.
  const correlation = makeClaudeResultCorrelation();
  const usage = makeLocalClaudeUsage();
  const reports = makeLocalClaudeReportDelivery(offer);
  let pendingUserReplay: PendingUserReplay | undefined;
  let pendingInterrupt: PendingInterrupt | undefined;
  let assignmentEpoch = 0;
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

  const cancelPending = (error: SubagentError) => {
    if (pendingUserReplay) {
      Deferred.doneUnsafe(pendingUserReplay.acknowledgement, Effect.fail(error));
      pendingUserReplay = undefined;
    }
    for (const pending of controlResponses.values())
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    controlResponses.clear();
    Deferred.doneUnsafe(nativeInitialization, Effect.fail(error));
    if (pendingInterrupt) {
      // Transport closure is a safe boundary for clearing interrupt ownership.
      Deferred.doneUnsafe(pendingInterrupt.terminal, Effect.fail(error));
      pendingInterrupt = undefined;
    }
    toolNames.clear();
    nativeToolNames.clear();
    correlation.clear();
    usage.clearMessageHistory();
    supervisor.cancelPending(error.message);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      cancelPending(
        processError("close", "local_claude_closed", "Local Claude Code backend closed."),
      );
      acknowledgeAll();
      Queue.endUnsafe(events);
    }),
  );

  const handleSupervisorEvent = (event: SupervisorEvent) =>
    event.type === "report" ? reports.bufferAcceptedReport(event) : offer(event);

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

  const isReplayConfirmation = (
    event: ClaudeUserProtocolEvent,
    pending: PendingUserReplay,
    sameSession: boolean,
  ): boolean =>
    // Exact UUID correlation only; content identity is diagnostic evidence and
    // never authorizes a replay.
    event.isReplay && event.uuid !== undefined && event.uuid === pending.uuid && sameSession;

  const isInterruptMarker = (event: ClaudeUserProtocolEvent, sameSession: boolean): boolean =>
    event.isReplay &&
    event.text === CLAUDE_INTERRUPT_MARKER &&
    event.toolResults.length === 0 &&
    event.uuid === undefined &&
    sameSession;

  const isQueuedTaskNotificationReplay = (event: ClaudeUserProtocolEvent): boolean =>
    pendingUserReplay === undefined &&
    claudeSessionDiagnostic(event.sessionId, nativeSessionId) === "match" &&
    assignmentEpoch > 0 &&
    correlation.hasOutstandingAssignment(assignmentEpoch) &&
    isClaudeQueuedTaskNotificationReplay(event);

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
      isClaudeQueuedTaskNotificationReplay(event));

  const isKnownReplay = (event: ClaudeUserProtocolEvent, sameSession: boolean): boolean =>
    // A delayed or duplicate replay of an input this handle already
    // confirmed is safely acknowledged only inside the native session.
    event.uuid !== undefined &&
    correlation.hasSentUuid(event.uuid) &&
    (event.isReplay || isInternalReplayOrigin(event.originKind, event.originSubkind)) &&
    sameSession;

  const pendingDiagnostic = (): ClaudeUserDiagnosticContext["pending"] =>
    pendingUserReplay?.operation ?? (pendingInterrupt ? "interrupt" : "none");

  const contentMatch = (event: ClaudeUserProtocolEvent): ClaudeSentContentMatch => {
    const digest = userContentDigest(event.text);
    const pending = pendingUserReplay;
    return pending?.contentDigest === digest
      ? sentKindForOperation(pending.operation)
      : correlation.matchSentContent(digest);
  };

  const diagnosticContext = (
    event: ClaudeUserProtocolEvent,
    sequence: number,
    nowMillis: number,
    report: ClaudeUserDiagnosticContext["report"],
  ): ClaudeUserDiagnosticContext => ({
    sequence,
    contentMatch: contentMatch(event),
    pending: pendingDiagnostic(),
    report,
    sinceOutbound: claudeOutboundAgeDiagnostic(nowMillis, lastOutboundAtMillis),
    traceEnabled: child.claudeDebug !== undefined,
  });

  const recordUserDecision = (
    event: ClaudeUserProtocolEvent,
    sequence: number,
    decision: Extract<LocalClaudeDebugEntry, { readonly kind: "user-decision" }>["decision"],
    report: ClaudeUserDiagnosticContext["report"],
  ) => {
    if (!child.claudeDebug) return Effect.void;
    return Effect.suspend(() => {
      const pending = pendingUserReplay;
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
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMillis) =>
        recordUserDecision(event, sequence, "unknown-before-report", report).pipe(
          Effect.andThen(
            offer(
              {
                type: "protocol_error",
                message: uncorrelatedClaudeUserMessage(
                  event,
                  nativeSessionId,
                  diagnosticContext(event, sequence, nowMillis, report),
                ),
              },
              raw,
            ),
          ),
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
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMillis) => {
              const message = uncorrelatedClaudeUserMessage(
                event,
                nativeSessionId,
                diagnosticContext(event, sequence, nowMillis, "accepted"),
              );
              // Completion evidence takes priority over the ordinary telemetry grace here: the
              // unexplained input requires prompt close-on-report settlement.
              return recordUserDecision(event, sequence, "unknown-after-report", "accepted").pipe(
                Effect.andThen(
                  offer(
                    {
                      type: "warning",
                      source: "runtime-extension",
                      message: `${message} The accepted supervisor report was preserved.`,
                    },
                    raw,
                  ),
                ),
                Effect.andThen(reports.forwardReport({ type: "report", ...report })),
              );
            }),
          );
        },
      }),
    );
  };

  const onUser = (event: ClaudeUserProtocolEvent, raw: LocalCliWireEvent, sequence: number) => {
    const sameSession = isSameClaudeSession(event.sessionId, nativeSessionId);
    const pending = pendingUserReplay;
    const interrupt = pendingInterrupt;
    if (event.parentToolUseId !== undefined) {
      // --forward-subagent-text emits nested assistant/user frames with
      // parent_tool_use_id. Text-only user frames are activity, while their tool
      // results retain the nested tool lifecycle used by write-claim observation.
      if (assignmentEpoch <= 0 || !sameSession)
        return rejectUncorrelatedUser(event, raw, sequence, "none");
      return recordUserDecision(event, sequence, "native-forward", "none").pipe(
        Effect.andThen(
          event.toolResults.length > 0
            ? handleToolResults(event.toolResults, raw)
            : offer({ type: "activity", assignmentEpoch }, raw),
        ),
      );
    }
    if (pending && isReplayConfirmation(event, pending, sameSession)) {
      return recordUserDecision(event, sequence, "pending-confirmation", "none").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            pendingUserReplay = undefined;
            correlation.rememberSentUuid(pending.uuid, {
              contentDigest: pending.contentDigest,
              kind: sentKindForOperation(pending.operation),
            });
            if (pending.resultKind)
              correlation.register(
                { uuid: pending.uuid, kind: pending.resultKind, epoch: pending.epoch },
                usage.baseline(),
              );
            Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
            return pending.emitRunStarted
              ? offer({ type: "run_started", assignmentEpoch: pending.epoch }, raw)
              : release(raw);
          }),
        ),
      );
    }
    if (interrupt && isInterruptMarker(event, sameSession)) {
      return recordUserDecision(event, sequence, "interrupt-marker", "none").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            interrupt.markerSeen = true;
            if (interrupt.resultSeen) {
              if (interrupt.abandoned) {
                pendingInterrupt = undefined;
                return offer({ type: "run_settled", assignmentEpoch: interrupt.epoch }, raw);
              }
              Deferred.doneUnsafe(interrupt.terminal, Effect.void);
            }
            return release(raw);
          }),
        ),
      );
    }
    if (isSyntheticSubturn(event, sameSession)) {
      const decision = isQueuedTaskNotificationReplay(event)
        ? "queued-task-notification"
        : "synthetic-subturn";
      return recordUserDecision(event, sequence, decision, "none").pipe(
        Effect.andThen(
          Effect.suspend(() => {
            // Claude-owned task notifications and auto-continuations are
            // causal subturns of the active assignment. Older frames may omit
            // their UUID; 2.1.259 command-queue replays may instead omit the
            // synthetic/origin flags. A private identity owns the result FIFO.
            const syntheticUuid = event.uuid ?? `synthetic:${randomUUID()}`;
            if (event.uuid !== undefined) correlation.rememberInternalReplayUuid(event.uuid);
            correlation.register(
              { uuid: syntheticUuid, kind: "synthetic", epoch: assignmentEpoch },
              usage.baseline(),
            );
            return offer({ type: "activity", assignmentEpoch }, raw);
          }),
        ),
      );
    }
    if (isKnownInternalReplay(event, sameSession))
      return recordUserDecision(event, sequence, "known-internal-replay", "none").pipe(
        Effect.andThen(release(raw)),
      );
    if (event.toolResults.length > 0)
      return recordUserDecision(event, sequence, "tool-results", "none").pipe(
        Effect.andThen(handleToolResults(event.toolResults, raw)),
      );
    if (isKnownReplay(event, sameSession))
      return recordUserDecision(event, sequence, "known-replay", "none").pipe(
        Effect.andThen(release(raw)),
      );
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
        if (CLAUDE_NATIVE_AGENT_TOOLS.has(tool.name)) {
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
          source: "runtime-extension",
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
          source: "runtime-extension",
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

  const settleInterruptResult = (interrupt: PendingInterrupt, raw: LocalCliWireEvent) =>
    Effect.suspend(() => {
      interrupt.resultSeen = true;
      if (interrupt.markerSeen) {
        if (interrupt.abandoned) {
          pendingInterrupt = undefined;
          return offer({ type: "run_settled", assignmentEpoch: interrupt.epoch }, raw);
        }
        Deferred.doneUnsafe(interrupt.terminal, Effect.void);
      }
      return release(raw);
    });

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
    const interrupt = pendingInterrupt;
    const interruptedResult =
      interrupt !== undefined &&
      event.isError &&
      event.subtype === "error_during_execution" &&
      event.stopReason === "aborted_streaming" &&
      ((event.userMessageUuid === undefined && expectation === undefined) ||
        (expectation?.kind === "assignment" && expectation.epoch === interrupt.epoch)) &&
      (event.sessionId === undefined ||
        nativeSessionId === undefined ||
        event.sessionId === nativeSessionId);
    if (interruptedResult)
      return reconcileResultUsage(event, expectation).pipe(
        Effect.andThen(reports.observeNativeResult(interrupt.epoch)),
        Effect.andThen(settleInterruptResult(interrupt, raw)),
      );
    if (event.isError)
      return reconcileResultUsage(event, expectation).pipe(
        Effect.andThen(
          offer(
            {
              type: "protocol_error",
              message: event.diagnostic
                ? `Claude Code result failed: ${event.diagnostic}`
                : "Claude Code result failed before a supervisor report was accepted.",
            },
            raw,
          ),
        ),
      );
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
        return offer({ type: "protocol_error", message: raw.message }, raw);
      if (raw.type === "exit") return release(raw);
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
          return recordInbound.pipe(
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
          Effect.flatMap((report) =>
            report
              ? reports
                  .forwardReport({ type: "report", ...report })
                  .pipe(Effect.timeoutOption("1 second"), Effect.asVoid)
              : Effect.void,
          ),
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
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(
      Effect.sync(() =>
        cancelPending(
          processError(
            "run",
            "local_claude_transport_closed",
            "Local Claude Code transport closed.",
          ),
        ),
      ).pipe(
        Effect.andThen(preserveAcceptedReport),
        Effect.ensuring(Effect.sync(() => Queue.endUnsafe(events))),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach(handleSupervisorEvent),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  const failUncertainDelivery = <A>(error: SubagentError): Effect.Effect<A, SubagentError> =>
    child.terminate("force").pipe(
      Effect.catch(() => Effect.void),
      Effect.andThen(Effect.fail(error)),
    );

  const sendUser = (
    text: string,
    epoch: number,
    operation: "initialize" | "start" | "steer",
    shouldQuery = true,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (pendingUserReplay)
          return {
            pending: undefined,
            error: processError(
              operation,
              `${operation}_not_sent`,
              "Another Claude stream-input delivery is awaiting native replay confirmation.",
            ),
          } as const;
        const pending: PendingUserReplay = {
          uuid: randomUUID(),
          operation,
          contentDigest: userContentDigest(text),
          epoch,
          emitRunStarted: operation === "start",
          // Steering joins the active turn and produces no dedicated result.
          resultKind:
            operation === "initialize"
              ? "initialization"
              : operation === "start"
                ? "assignment"
                : undefined,
          acknowledgement: Deferred.makeUnsafe<void, SubagentError>(),
        };
        pendingUserReplay = pending;
        return { pending } as const;
      }),
      (acquired) => {
        if (!("pending" in acquired) || !acquired.pending) return Effect.fail(acquired.error);
        const timeoutError = processError(
          operation,
          `${operation}_outcome_uncertain`,
          "Claude stream input was sent but native replay confirmation did not arrive; the backend was closed to prevent ambiguous retry correlation.",
        );
        const recordOutbound = Clock.currentTimeMillis.pipe(
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
        );
        return recordOutbound.pipe(
          Effect.andThen(
            child.send(claudeUserFrame(text, { shouldQuery, uuid: acquired.pending.uuid })),
          ),
          Effect.mapError((error) =>
            error.code === "transport_outcome_uncertain"
              ? processError(
                  operation,
                  `${operation}_outcome_uncertain`,
                  `Claude stream input may already have been accepted; inspect run status before retrying. (${error.message})`,
                )
              : error,
          ),
          Effect.catch((error) =>
            error instanceof SubagentProcessError && isOutcomeUncertain(error)
              ? failUncertainDelivery(error)
              : Effect.fail(error),
          ),
          Effect.andThen(Deferred.await(acquired.pending.acknowledgement)),
          Effect.timeout(CONTROL_TIMEOUT),
          // Interrupt the pending send/acknowledgement before force-closing its transport.
          Effect.catchTag("TimeoutError", () => failUncertainDelivery(timeoutError)),
        );
      },
      (acquired) =>
        Effect.sync(() => {
          if ("pending" in acquired && pendingUserReplay === acquired.pending)
            pendingUserReplay = undefined;
        }),
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
      send: (frame) =>
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
          ),
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
    yield* sendUser(INITIALIZATION_PROBE, 0, "initialize", false);
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

    let supervisorReady = false;
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
        if (SUPERVISOR_MCP_TOOL_NAMES.every((tool) => inventory.has(tool))) {
          supervisorReady = true;
          break;
        }
        return yield* processError(
          "initialize",
          "claude_supervisor_tools_missing",
          "Claude Code connected the private supervisor MCP server without its mandatory tool inventory.",
        );
      }
      if (server && server.status !== "pending" && server.status !== "connecting") break;
      yield* Effect.sleep("50 millis");
    }
    if (!supervisorReady)
      return yield* processError(
        "initialize",
        "claude_supervisor_mcp_unavailable",
        "Claude Code did not connect the mandatory pi_subagents_supervisor MCP server.",
      );
    return {
      model: native.model,
      effort: request.effort,
      sessionId: native.sessionId,
    };
  });

  const interrupt = Effect.acquireUseRelease(
    Effect.sync(() => {
      if (pendingInterrupt)
        return {
          lifecycle: undefined,
          error: processError(
            "interrupt",
            "interrupt_not_sent",
            pendingInterrupt.abandoned
              ? "A previous Claude interrupt lifecycle is still unresolved; a second interrupt would be ambiguously correlated."
              : "Another Claude interrupt lifecycle is already pending.",
          ),
        } as const;
      const requestId = `interrupt-${nextControlId++}`;
      const lifecycle: PendingInterrupt = {
        requestId,
        epoch: assignmentEpoch,
        response: Deferred.makeUnsafe<unknown, SubagentError>(),
        terminal: Deferred.makeUnsafe<void, SubagentError>(),
        markerSeen: false,
        resultSeen: false,
        abandoned: false,
      };
      pendingInterrupt = lifecycle;
      controlResponses.set(requestId, { operation: "interrupt", deferred: lifecycle.response });
      return { lifecycle } as const;
    }),
    (acquired) => {
      if (!acquired.lifecycle) return Effect.fail(acquired.error);
      const lifecycle = acquired.lifecycle;
      const response = child.send(claudeInterruptFrame(lifecycle.requestId)).pipe(
        Effect.mapError((error) =>
          error.code === "transport_outcome_uncertain"
            ? processError(
                "interrupt",
                "interrupt_outcome_uncertain",
                `Claude interrupt may already have applied; it will not be retried. (${error.message})`,
              )
            : error,
        ),
        Effect.andThen(Deferred.await(lifecycle.response)),
      );
      return Effect.all([response, Deferred.await(lifecycle.terminal)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.timeoutOrElse({
          duration: CONTROL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              processError(
                "interrupt",
                "interrupt_outcome_uncertain",
                "Claude interrupt did not complete its correlated response, replay marker, and aborted result lifecycle; it will not be retried.",
              ),
            ),
        }),
      );
    },
    (acquired, exit) =>
      Effect.suspend(() => {
        if (!acquired.lifecycle) return Effect.void;
        controlResponses.delete(acquired.lifecycle.requestId);
        if (pendingInterrupt !== acquired.lifecycle) return Effect.void;
        // An uncertain or cancelled interrupt retains exact lifecycle ownership:
        // a late correlated marker+result pair then pauses through run_settled.
        // Definite success or definite rejection releases ownership immediately.
        const ownership = classifyLocalCliInterruptOwnership(exit);
        if (ownership === "release") {
          pendingInterrupt = undefined;
          return Effect.void;
        }
        acquired.lifecycle.abandoned = true;
        // The marker/result pair may already be complete while only the control
        // response is missing. Emit settlement now or no later native event would
        // remain to resolve the orchestration-level pending pause.
        if (!acquired.lifecycle.markerSeen || !acquired.lifecycle.resultSeen) return Effect.void;
        pendingInterrupt = undefined;
        return offer({ type: "run_settled", assignmentEpoch: acquired.lifecycle.epoch });
      }),
  );

  return {
    pid: child.pid,
    events,
    awaitExit: child.awaitExit.pipe(Effect.map(toBackendExit)),
    controls: {
      initialize,
      start: (message: string, epoch: number) =>
        supervisor.setAssignmentEpoch(epoch).pipe(
          Effect.mapError((error) => processError("start", error.code, error.message)),
          Effect.andThen(
            Effect.sync(() => {
              assignmentEpoch = epoch;
            }),
          ),
          Effect.andThen(sendUser(message, epoch, "start")),
        ),
      steer: (message: string) => sendUser(message, assignmentEpoch, "steer"),
      interrupt,
      renameDisplay: () => Effect.fail(unsupported("rename-display")),
      reply: (requestId: string, message: string) =>
        supervisor
          .reply(requestId, message)
          .pipe(Effect.mapError((error) => processError("reply", error.code, error.message))),
      notifyPeers: () => Effect.fail(unsupported("peer-notice")),
    },
    acknowledge,
    terminate: child.terminate,
    cancelPending,
  };
});

export const makeLocalClaudeBackendDriver = (
  processes: LocalCliProcessContract,
  supervisors: SupervisorChannelContract,
): BackendDriver => ({
  host: "local",
  runtime: "claude",
  capabilities: ["steer", "interrupt", "parent-contact"],
  supportsContext: (context) => context === "fresh",
  preflight: (request) => processes.preflight({ runtime: "claude", ...request }),
  spawn: (request) =>
    Effect.gen(function* () {
      const launch = withLocalSupervisorInstructions(request);
      const supervisor = yield* supervisors
        .open({ runId: request.runId })
        .pipe(
          Effect.mapError((error) =>
            processError("open supervisor channel", error.code, error.message),
          ),
        );
      const child = yield* processes.spawn({
        runtime: "claude",
        launch,
        supervisor: supervisor.metadata,
      });
      return yield* makeLocalClaudeHandle(launch, child, supervisor);
    }),
});
