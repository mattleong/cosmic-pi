// The stream-input correlation UUID is plain-crypto identity, not an Effect resource.
// @effect-diagnostics effect/cryptoRandomUUID:off
import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  LocalCliProcess,
  type LocalCliHandle,
  type LocalCliProcessShape,
  type LocalCliWireEvent,
} from "../boundary/local-cli-process.ts";
import {
  SupervisorChannel,
  type SupervisorChannelHandle,
  type SupervisorChannelShape,
} from "../boundary/supervisor-channel.ts";
import {
  SubagentProcessError,
  UnsupportedSubagentCapabilityError,
  type SubagentError,
} from "../run/errors.ts";
import type { SupervisorEvent } from "../supervisor/protocol.ts";
import type { BackendDriver, BackendEvent, BackendLaunchRequest } from "./model.ts";
import { withLocalSupervisorInstructions } from "./local-supervisor-prompt.ts";
import {
  CLAUDE_INTERRUPT_MARKER,
  CLAUDE_SUPERVISOR_SERVER_NAME,
  CLAUDE_SUPERVISOR_TOOL_NAMES,
  claudeInitializeFrame,
  claudeInterruptFrame,
  claudeMcpStatusFrame,
  claudeUserFrame,
  decodeClaudeInitializeControlResponse,
  decodeClaudeMcpStatusControlResponse,
  decodeClaudeProtocolEvent,
  type ClaudeNativeInitialization,
} from "./local-claude-protocol.ts";

const EVENT_CAPACITY = 512;
const CONTROL_TIMEOUT = "10 seconds";
// Native finalization after the report tool may require another model step.
const RESULT_REPORT_GRACE = "10 seconds";
const MCP_READY_ATTEMPTS = 100;
const INITIALIZATION_PROBE = "pi-subagents native initialization probe";
const SENT_UUID_LIMIT = 64;
const ASSISTANT_USAGE_MESSAGE_LIMIT = 32;
const INTERNAL_REPLAY_ORIGINS: ReadonlySet<string> = new Set([
  "task-notification",
  "auto-continuation",
]);

const processError = (operation: string, code: string, message: string) =>
  new SubagentProcessError({ operation, code, message });

const unsupported = (capability: string) =>
  new UnsupportedSubagentCapabilityError({
    backend: "local/claude",
    capability,
    message: `Local Claude Code does not provide a confirmable ${capability} operation.`,
  });

interface PendingUserReplay {
  readonly uuid: string;
  readonly epoch: number;
  readonly emitRunStarted: boolean;
  readonly resultKind: "initialization" | "assignment" | undefined;
  readonly acknowledgement: Deferred.Deferred<void, SubagentError>;
}

interface PendingControl {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

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

/** Correlates a native result to the exact user input that started its query. */
interface ResultExpectation {
  readonly uuid: string;
  readonly kind: "initialization" | "assignment" | "synthetic";
  readonly epoch: number;
  /** Global emitted-usage watermark when this exact native query was registered. */
  readonly usageBaseline: UsageComponents;
}

interface UsageComponents {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

const zeroComponents: UsageComponents = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const componentwiseMax = (left: UsageComponents, right: UsageComponents): UsageComponents => ({
  input: Math.max(left.input, right.input),
  output: Math.max(left.output, right.output),
  cacheRead: Math.max(left.cacheRead, right.cacheRead),
  cacheWrite: Math.max(left.cacheWrite, right.cacheWrite),
});

/**
 * Nonnegative componentwise delta between cumulative native usage snapshots.
 * A regressing native total is reported as inconsistent and never subtracted.
 */
const cumulativeUsageDelta = (
  previous: UsageComponents,
  next: UsageComponents,
): { readonly delta: UsageComponents; readonly inconsistent: boolean } => ({
  delta: {
    input: Math.max(0, next.input - previous.input),
    output: Math.max(0, next.output - previous.output),
    cacheRead: Math.max(0, next.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, next.cacheWrite - previous.cacheWrite),
  },
  inconsistent:
    next.input < previous.input ||
    next.output < previous.output ||
    next.cacheRead < previous.cacheRead ||
    next.cacheWrite < previous.cacheWrite,
});

const componentsTotal = (components: UsageComponents): number =>
  components.input + components.output + components.cacheRead + components.cacheWrite;

const makeLocalClaudeHandle = Effect.fn("LocalClaudeBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliHandle,
  supervisor: SupervisorChannelHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const rawOwners = new Map<BackendEvent, LocalCliWireEvent>();
  const controlResponses = new Map<string, PendingControl>();
  const nativeInitialization = Deferred.makeUnsafe<ClaudeNativeInitialization, SubagentError>();
  const toolNames = new Map<string, string>();
  // Bounded identity of every confirmed outbound input so delayed or duplicate
  // replays of a known UUID stay nonfatal while unknown replays fail closed.
  const sentUserUuids = new Set<string>();
  const resultExpectations = new Map<string, ResultExpectation>();
  /** FIFO used only when the current protocol legitimately omits user_message_uuid. */
  const resultOrder: ResultExpectation[] = [];
  const assistantUsageByMessage = new Map<string, UsageComponents>();
  let emittedUsageTotals: UsageComponents = zeroComponents;
  const bufferedReports = new Map<number, Extract<BackendEvent, { readonly type: "report" }>>();
  const nativeResultEpochs = new Set<number>();
  const forwardingReports = new Map<number, Deferred.Deferred<boolean>>();
  const forwardedReportEpochs = new Set<number>();
  let pendingUserReplay: PendingUserReplay | undefined;
  let pendingInterrupt: PendingInterrupt | undefined;
  let assignmentEpoch = 0;
  let nextControlId = 1;
  let initializationStarted = false;
  let nativeSessionId: string | undefined;

  const rememberSentUuid = (uuid: string) => {
    sentUserUuids.delete(uuid);
    sentUserUuids.add(uuid);
    while (sentUserUuids.size > SENT_UUID_LIMIT) {
      const oldest = sentUserUuids.values().next().value;
      if (oldest === undefined) break;
      sentUserUuids.delete(oldest);
    }
  };
  const registerResultExpectation = (expectation: Omit<ResultExpectation, "usageBaseline">) => {
    const owned = { ...expectation, usageBaseline: { ...emittedUsageTotals } };
    resultExpectations.set(owned.uuid, owned);
    resultOrder.push(owned);
    while (resultOrder.length > SENT_UUID_LIMIT) {
      const oldest = resultOrder.shift();
      if (oldest) resultExpectations.delete(oldest.uuid);
    }
  };
  const takeResultExpectation = (
    userMessageUuid: string | undefined,
    originKind: string | undefined,
  ): ResultExpectation | undefined => {
    if (userMessageUuid !== undefined) {
      const expectation = resultExpectations.get(userMessageUuid);
      if (!expectation) return undefined;
      resultExpectations.delete(userMessageUuid);
      const index = resultOrder.indexOf(expectation);
      if (index >= 0) resultOrder.splice(index, 1);
      return expectation;
    }
    const index = INTERNAL_REPLAY_ORIGINS.has(originKind ?? "")
      ? resultOrder.findIndex((candidate) => candidate.kind === "synthetic")
      : 0;
    if (index < 0) return undefined;
    const [expectation] = resultOrder.splice(index, 1);
    if (expectation) resultExpectations.delete(expectation.uuid);
    return expectation;
  };

  const acknowledge = (event: BackendEvent) => {
    const raw = rawOwners.get(event);
    if (!raw) return;
    rawOwners.delete(event);
    child.acknowledge(raw);
  };
  const acknowledgeAll = () => {
    for (const raw of rawOwners.values()) child.acknowledge(raw);
    rawOwners.clear();
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
    sentUserUuids.clear();
    resultExpectations.clear();
    resultOrder.length = 0;
    assistantUsageByMessage.clear();
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

  const offer = (event: BackendEvent, raw?: LocalCliWireEvent) =>
    Effect.suspend(() => {
      if (raw) rawOwners.set(event, raw);
      let offered = false;
      return Queue.offer(events, event).pipe(
        Effect.tap(() => Effect.sync(() => void (offered = true))),
        Effect.ensuring(
          Effect.sync(() => {
            if (!offered && raw) acknowledge(event);
          }),
        ),
        Effect.asVoid,
      );
    });

  function forwardReport(
    report: Extract<BackendEvent, { readonly type: "report" }>,
  ): Effect.Effect<void, Cause.Done> {
    return Effect.suspend(() => {
      const epoch = report.assignmentEpoch;
      if (forwardedReportEpochs.has(epoch)) return Effect.void;
      const existing = forwardingReports.get(epoch);
      if (existing)
        return Deferred.await(existing).pipe(
          Effect.flatMap((forwarded) => (forwarded ? Effect.void : forwardReport(report))),
        );
      const completion = Deferred.makeUnsafe<boolean>();
      forwardingReports.set(epoch, completion);
      let forwarded = false;
      return offer(report).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            forwarded = true;
            forwardedReportEpochs.add(epoch);
            bufferedReports.delete(epoch);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            forwardingReports.delete(epoch);
            Deferred.doneUnsafe(completion, Effect.succeed(forwarded));
          }),
        ),
      );
    });
  }

  const releaseReportAfterNativeResult = (epoch: number) =>
    Effect.suspend(() => {
      nativeResultEpochs.add(epoch);
      const report = bufferedReports.get(epoch);
      return report ? forwardReport(report) : Effect.void;
    });

  const handleSupervisorEvent = (event: SupervisorEvent) => {
    if (event.type !== "report") return offer(event);
    if (nativeResultEpochs.has(event.assignmentEpoch)) return forwardReport(event);
    // Hold the accepted report briefly so final native usage/cost is forwarded
    // first. Otherwise report settlement closes the backend scope and races away
    // Claude's trailing result frame. The bound preserves completion if Claude
    // never emits that frame.
    bufferedReports.set(event.assignmentEpoch, event);
    return Effect.sleep(RESULT_REPORT_GRACE).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          bufferedReports.get(event.assignmentEpoch) === event ? forwardReport(event) : Effect.void,
        ),
      ),
      Effect.forkScoped,
      Effect.asVoid,
    );
  };

  const consumeRaw = (raw: LocalCliWireEvent): Effect.Effect<void> => {
    if (raw.type === "protocol_error")
      return offer({ type: "protocol_error", message: raw.message }, raw);
    if (raw.type === "exit") {
      child.acknowledge(raw);
      return Effect.void;
    }
    return decodeClaudeProtocolEvent(raw.value).pipe(
      Effect.flatMap((event) => {
        switch (event.type) {
          case "ignored":
            child.acknowledge(raw);
            return Effect.void;
          case "init":
            nativeSessionId = event.sessionId;
            Deferred.doneUnsafe(nativeInitialization, Effect.succeed(event));
            child.acknowledge(raw);
            return Effect.void;
          case "activity":
            return offer({ type: "activity", assignmentEpoch }, raw);
          case "user": {
            const pending = pendingUserReplay;
            // Exact UUID correlation only; the pinned protocol replays the
            // caller-supplied input uuid, so no text matching is consulted.
            if (
              pending &&
              event.isReplay &&
              event.uuid !== undefined &&
              event.uuid === pending.uuid &&
              (event.sessionId === undefined ||
                nativeSessionId === undefined ||
                event.sessionId === nativeSessionId)
            ) {
              pendingUserReplay = undefined;
              rememberSentUuid(pending.uuid);
              if (pending.resultKind)
                registerResultExpectation({
                  uuid: pending.uuid,
                  kind: pending.resultKind,
                  epoch: pending.epoch,
                });
              Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
              return pending.emitRunStarted
                ? offer({ type: "run_started", assignmentEpoch: pending.epoch }, raw)
                : Effect.sync(() => child.acknowledge(raw));
            }
            const interrupt = pendingInterrupt;
            if (
              interrupt &&
              event.isReplay &&
              event.text === CLAUDE_INTERRUPT_MARKER &&
              event.toolResults.length === 0 &&
              event.uuid === undefined &&
              (event.sessionId === undefined ||
                nativeSessionId === undefined ||
                event.sessionId === nativeSessionId)
            ) {
              interrupt.markerSeen = true;
              if (interrupt.resultSeen) {
                if (interrupt.abandoned) {
                  pendingInterrupt = undefined;
                  return offer({ type: "run_settled", assignmentEpoch: interrupt.epoch }, raw);
                }
                Deferred.doneUnsafe(interrupt.terminal, Effect.void);
              }
              child.acknowledge(raw);
              return Effect.void;
            }
            if (
              event.uuid !== undefined &&
              !sentUserUuids.has(event.uuid) &&
              INTERNAL_REPLAY_ORIGINS.has(event.originKind ?? "") &&
              assignmentEpoch > 0
            ) {
              // Claude-owned task notifications/auto-continuations are causal
              // subturns of the active assignment, not foreign parent input.
              // Their required UUID owns only their synthetic result lifecycle.
              rememberSentUuid(event.uuid);
              registerResultExpectation({
                uuid: event.uuid,
                kind: "synthetic",
                epoch: assignmentEpoch,
              });
              return offer({ type: "activity", assignmentEpoch }, raw);
            }
            if (event.toolResults.length > 0)
              return Effect.gen(function* () {
                for (const [index, result] of event.toolResults.entries()) {
                  const name = toolNames.get(result.id) ?? "ClaudeTool";
                  toolNames.delete(result.id);
                  yield* offer(
                    {
                      type: "tool_finished",
                      assignmentEpoch,
                      toolCallId: result.id,
                      toolName: name,
                      isError: result.isError,
                    },
                    index === event.toolResults.length - 1 ? raw : undefined,
                  );
                }
              });
            // A delayed or duplicate replay of an input this handle already
            // confirmed is safely acknowledged without further effect.
            if (
              event.uuid !== undefined &&
              sentUserUuids.has(event.uuid) &&
              (event.isReplay || INTERNAL_REPLAY_ORIGINS.has(event.originKind ?? ""))
            ) {
              child.acknowledge(raw);
              return Effect.void;
            }
            return offer(
              {
                type: "protocol_error",
                message: "Claude replayed an uncorrelated stream-input message.",
              },
              raw,
            );
          }
          case "control_response": {
            const pending = controlResponses.get(event.requestId);
            if (!pending) {
              child.acknowledge(raw);
              return Effect.void;
            }
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
            child.acknowledge(raw);
            return Effect.void;
          }
          case "assistant":
            return Effect.gen(function* () {
              for (const tool of event.tools) {
                toolNames.set(tool.id, tool.name);
                yield* offer({
                  type: "tool_started",
                  assignmentEpoch,
                  toolCallId: tool.id,
                  toolName: tool.name,
                  args: tool.input,
                });
              }
              // Native assistant usage repeats cumulatively per message id, so
              // only the nonnegative delta for the same id is accounted.
              const previous = event.messageId
                ? assistantUsageByMessage.get(event.messageId)
                : undefined;
              const { delta, inconsistent } = cumulativeUsageDelta(
                previous ?? zeroComponents,
                event.usage,
              );
              if (event.messageId) {
                assistantUsageByMessage.delete(event.messageId);
                assistantUsageByMessage.set(
                  event.messageId,
                  componentwiseMax(previous ?? zeroComponents, event.usage),
                );
                while (assistantUsageByMessage.size > ASSISTANT_USAGE_MESSAGE_LIMIT) {
                  const oldest = assistantUsageByMessage.keys().next().value;
                  if (oldest === undefined) break;
                  assistantUsageByMessage.delete(oldest);
                }
              }
              emittedUsageTotals = {
                input: emittedUsageTotals.input + delta.input,
                output: emittedUsageTotals.output + delta.output,
                cacheRead: emittedUsageTotals.cacheRead + delta.cacheRead,
                cacheWrite: emittedUsageTotals.cacheWrite + delta.cacheWrite,
              };
              if (inconsistent)
                yield* offer({
                  type: "warning",
                  source: "runtime-extension",
                  message:
                    "Claude reported a regressing cumulative assistant usage total; accounting stays monotone and the regression was ignored.",
                });
              yield* offer(
                {
                  type: "assistant_message",
                  assignmentEpoch,
                  ...(event.text ? { text: event.text } : {}),
                  usage: { ...delta, totalTokens: componentsTotal(delta) },
                },
                raw,
              );
            });
          case "result": {
            // Correlate to the exact originating input: the native
            // user_message_uuid when reported, otherwise the owned issue-order
            // FIFO for a pinned protocol frame that legitimately omits it.
            const expectation = takeResultExpectation(event.userMessageUuid, event.originKind);
            // Result-level cumulative usage/cost reconciliation: emit only the
            // nonnegative remainder over already-accounted assistant deltas so
            // nothing is double-counted, and surface the known cost estimate.
            const reconcileUsage = Effect.suspend(() => {
              if (
                expectation === undefined ||
                expectation.kind === "initialization" ||
                (event.usage === undefined && event.totalCostUsd === undefined)
              )
                return Effect.void;
              const emittedForQuery: UsageComponents = {
                input: Math.max(0, emittedUsageTotals.input - expectation.usageBaseline.input),
                output: Math.max(0, emittedUsageTotals.output - expectation.usageBaseline.output),
                cacheRead: Math.max(
                  0,
                  emittedUsageTotals.cacheRead - expectation.usageBaseline.cacheRead,
                ),
                cacheWrite: Math.max(
                  0,
                  emittedUsageTotals.cacheWrite - expectation.usageBaseline.cacheWrite,
                ),
              };
              const { delta, inconsistent } = event.usage
                ? cumulativeUsageDelta(emittedForQuery, event.usage)
                : { delta: zeroComponents, inconsistent: false };
              emittedUsageTotals = {
                input: emittedUsageTotals.input + delta.input,
                output: emittedUsageTotals.output + delta.output,
                cacheRead: emittedUsageTotals.cacheRead + delta.cacheRead,
                cacheWrite: emittedUsageTotals.cacheWrite + delta.cacheWrite,
              };
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
                componentsTotal(delta) > 0 || costDelta !== undefined
                  ? offer({
                      type: "assistant_message",
                      assignmentEpoch: expectation.epoch,
                      usage: {
                        ...delta,
                        totalTokens: componentsTotal(delta),
                        ...(costDelta === undefined ? {} : { cost: costDelta }),
                      },
                    })
                  : Effect.void;
              return warn.pipe(Effect.andThen(emit));
            });
            const interrupt = pendingInterrupt;
            const expectedInterruptedResult =
              interrupt !== undefined &&
              event.isError &&
              event.subtype === "error_during_execution" &&
              event.stopReason === "aborted_streaming" &&
              ((event.userMessageUuid === undefined && expectation === undefined) ||
                (expectation?.kind === "assignment" && expectation.epoch === interrupt.epoch)) &&
              (event.sessionId === undefined ||
                nativeSessionId === undefined ||
                event.sessionId === nativeSessionId);
            if (expectedInterruptedResult) {
              return reconcileUsage.pipe(
                Effect.andThen(releaseReportAfterNativeResult(interrupt.epoch)),
                Effect.andThen(
                  Effect.suspend(() => {
                    interrupt.resultSeen = true;
                    if (interrupt.markerSeen) {
                      if (interrupt.abandoned) {
                        pendingInterrupt = undefined;
                        return offer(
                          { type: "run_settled", assignmentEpoch: interrupt.epoch },
                          raw,
                        );
                      }
                      Deferred.doneUnsafe(interrupt.terminal, Effect.void);
                    }
                    child.acknowledge(raw);
                    return Effect.void;
                  }),
                ),
              );
            }
            if (event.isError)
              return reconcileUsage.pipe(
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
            if (expectation?.kind === "initialization")
              return Effect.sync(() => child.acknowledge(raw));
            if (expectation?.kind === "synthetic")
              return reconcileUsage.pipe(Effect.andThen(Effect.sync(() => child.acknowledge(raw))));
            if (expectation === undefined)
              return offer(
                {
                  type: "protocol_error",
                  message: "Claude Code emitted a result that no issued input correlates to.",
                },
                raw,
              );
            // Assignment results may be acknowledged only after the MCP report
            // call recorded causal acceptance for the correlated epoch.
            const completedEpoch = expectation.epoch;
            return reconcileUsage.pipe(
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
                        ? Effect.sync(() => child.acknowledge(raw)).pipe(
                            Effect.andThen(releaseReportAfterNativeResult(completedEpoch)),
                          )
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
          }
        }
      }),
      Effect.catch(() =>
        offer(
          { type: "protocol_error", message: "Claude Code emitted an invalid stream event." },
          raw,
        ),
      ),
    );
  };

  const preserveAcceptedReport = Effect.suspend(() =>
    assignmentEpoch <= 0
      ? Effect.void
      : supervisor.acceptedReportForEpoch(assignmentEpoch).pipe(
          Effect.flatMap((report) =>
            report
              ? forwardReport({ type: "report", ...report }).pipe(
                  Effect.timeoutOption("1 second"),
                  Effect.asVoid,
                )
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
        return child.send(claudeUserFrame(text, { shouldQuery, uuid: acquired.pending.uuid })).pipe(
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
            error instanceof SubagentProcessError && error.code?.endsWith("_outcome_uncertain")
              ? failUncertainDelivery(error)
              : Effect.fail(error),
          ),
          Effect.andThen(Deferred.await(acquired.pending.acknowledgement)),
          Effect.timeoutOption(CONTROL_TIMEOUT),
          Effect.flatMap((outcome) =>
            Option.isSome(outcome)
              ? Effect.void
              : failUncertainDelivery(
                  processError(
                    operation,
                    `${operation}_outcome_uncertain`,
                    "Claude stream input was sent but native replay confirmation did not arrive; the backend was closed to prevent ambiguous retry correlation.",
                  ),
                ),
          ),
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
    makeFrame: (requestId: string) => Readonly<Record<string, unknown>>,
  ): Effect.Effect<unknown, SubagentError> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requestId = `${operation}-${nextControlId++}`;
        const deferred = Deferred.makeUnsafe<unknown, SubagentError>();
        controlResponses.set(requestId, { operation, deferred });
        return { requestId, deferred };
      }),
      ({ requestId, deferred }) =>
        child.send(makeFrame(requestId)).pipe(
          Effect.mapError((error) =>
            error.code === "transport_outcome_uncertain"
              ? processError(
                  operation,
                  `${operation}_outcome_uncertain`,
                  `Claude ${operation} may already have applied; it will not be retried. (${error.message})`,
                )
              : error,
          ),
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption(CONTROL_TIMEOUT),
          Effect.flatMap((outcome) =>
            Option.isSome(outcome)
              ? Effect.succeed(outcome.value)
              : Effect.fail(
                  processError(
                    operation,
                    `${operation}_outcome_uncertain`,
                    `Claude ${operation} was sent but no correlated native response arrived; it will not be retried.`,
                  ),
                ),
          ),
        ),
      ({ requestId }) => Effect.sync(() => void controlResponses.delete(requestId)),
    );

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
      Effect.timeoutOption(CONTROL_TIMEOUT),
      Effect.flatMap((outcome) =>
        Option.isSome(outcome)
          ? Effect.succeed(outcome.value)
          : Effect.fail(
              processError(
                "initialize",
                "claude_native_init_missing",
                "Claude Code did not emit its mandatory native system/init event.",
              ),
            ),
      ),
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
        (candidate) => candidate.name === CLAUDE_SUPERVISOR_SERVER_NAME,
      );
      if (server?.status === "connected") {
        const inventory = new Set(server.tools?.map((tool) => tool.name) ?? []);
        if (CLAUDE_SUPERVISOR_TOOL_NAMES.every((tool) => inventory.has(tool))) {
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
        Effect.timeoutOption(CONTROL_TIMEOUT),
        Effect.flatMap((outcome) =>
          Option.isSome(outcome)
            ? Effect.void
            : Effect.fail(
                processError(
                  "interrupt",
                  "interrupt_outcome_uncertain",
                  "Claude interrupt did not complete its correlated response, replay marker, and aborted result lifecycle; it will not be retried.",
                ),
              ),
        ),
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
        const retainOwnership =
          Exit.isFailure(exit) &&
          (exit.cause.reasons.every(Cause.isInterruptReason) ||
            (() => {
              const error = Cause.squash(exit.cause);
              return (
                typeof error === "object" &&
                error !== null &&
                "_tag" in error &&
                error._tag === "SubagentProcessError" &&
                (error as SubagentProcessError).code === "interrupt_outcome_uncertain"
              );
            })());
        if (!retainOwnership) {
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
    awaitExit: child.awaitExit.pipe(
      Effect.map((event) => ({
        type: "exit" as const,
        exitCode: event.exitCode,
        ...(event.signal ? { signal: event.signal } : {}),
        diagnostic: event.stderr,
      })),
    ),
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
  processes: LocalCliProcessShape,
  supervisors: SupervisorChannelShape,
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

export const localClaudeBackendDriver = Effect.gen(function* () {
  const processes = yield* LocalCliProcess;
  const supervisors = yield* SupervisorChannel;
  return makeLocalClaudeBackendDriver(processes, supervisors);
});
