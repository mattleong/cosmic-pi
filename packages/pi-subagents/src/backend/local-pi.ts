import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  type ChildLaunchRequest,
  type ChildProcessHandle,
  type ChildProcessContract,
  type ChildWireEvent,
} from "../boundary/child-process.ts";
import {
  InvalidSubagentRequestError,
  isOutcomeUncertain,
  SubagentProcessError,
  SubagentProtocolError,
  type SubagentError,
} from "../run/errors.ts";
import { PI_SUBAGENT_CAPABILITIES, type SubagentUsage } from "../run/model.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import {
  assistantText,
  decodeAssistantMessage,
  decodeRpcEnvelope,
  decodeRpcStateData,
  decodeRpcUsageOption,
  rpcStateModelId,
  type RpcCommand,
  type RpcResponse,
} from "./local-pi-protocol.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "../run/state.ts";
import {
  toBackendExit,
  type BackendDriver,
  type BackendEvent,
  type BackendLaunchRequest,
  type BackendResumeToken,
} from "./model.ts";

const RPC_TIMEOUT = "10 seconds";
const EVENT_CAPACITY = 512;

const protocolError = (message: string) => new SubagentProtocolError({ message });
const noBackendEvent: Effect.Effect<BackendEvent | undefined> = Effect.as(Effect.void, undefined);
const usageFromRpc = (usage: ReturnType<typeof decodeRpcUsageOption>): SubagentUsage =>
  (() => {
    const baseResult = {
      input: usage?.input ?? 0,
      output: usage?.output ?? 0,
      cacheRead: usage?.cacheRead ?? 0,
      cacheWrite: usage?.cacheWrite ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
    };
    const withCost =
      usage?.cost?.total === undefined ? baseResult : { ...baseResult, cost: usage.cost.total };
    return withCost;
  })();

const rpcOutcomeCode = (command: string): string => {
  switch (command) {
    case "steer":
      return "guidance_outcome_uncertain";
    case "clear_queue":
      return "clear_queue_outcome_uncertain";
    case "abort":
      return "interrupt_outcome_uncertain";
    case "set_session_name":
      return "rename_outcome_uncertain";
    default:
      return `${command}_outcome_uncertain`;
  }
};

const mapTransportUncertainty = (command: RpcCommand, error: SubagentError): SubagentError =>
  error._tag === "SubagentProcessError" && error.code === "transport_outcome_uncertain"
    ? new SubagentProcessError({
        operation: `execute ${command.type} in`,
        code: rpcOutcomeCode(command.type),
        message:
          command.type === "clear_queue"
            ? `${error.message} Queue clearing could not be confirmed; abort was not sent. Inspect subagent status before retrying interrupt.`
            : `${error.message} Inspect subagent status before retrying ${command.type}.`,
      })
    : error;

const normalizeRpcEvent = <ValueInput>(value: ValueInput, assignmentEpoch: number) =>
  decodeRpcEnvelope(value).pipe(
    Effect.flatMap((envelope) => {
      switch (envelope.type) {
        case "response":
        case "agent_end":
        case "ignored":
          return noBackendEvent;
        case "agent_start":
          return Effect.succeed<BackendEvent>({ type: "run_started", assignmentEpoch });
        case "agent_settled":
          return Effect.succeed<BackendEvent>({ type: "run_settled", assignmentEpoch });
        case "message_update":
          return Effect.succeed(
            envelope.assistantMessageEvent.type === "text_delta" &&
              envelope.assistantMessageEvent.delta
              ? ({ type: "activity", assignmentEpoch } as const)
              : undefined,
          );
        case "message_end":
          return decodeAssistantMessage(envelope.message).pipe(
            Effect.map((message) =>
              message
                ? (() => {
                    const baseResult = {
                      type: "assistant_message" as const,
                      assignmentEpoch,
                    };
                    const withText = assistantText(message)
                      ? { ...baseResult, text: assistantText(message) }
                      : baseResult;
                    const withUsage = {
                      ...withText,
                      usage: usageFromRpc(decodeRpcUsageOption(message.usage)),
                    };
                    return withUsage;
                  })()
                : undefined,
            ),
          );
        case "tool_execution_start":
          return Effect.succeed<BackendEvent>({
            type: "tool_started",
            assignmentEpoch,
            toolCallId: envelope.toolCallId,
            toolName: envelope.toolName,
            args: envelope.args,
          });
        case "tool_execution_end":
          return Effect.succeed<BackendEvent>({
            type: "tool_finished",
            assignmentEpoch,
            toolCallId: envelope.toolCallId,
            toolName: envelope.toolName,
            isError: envelope.isError,
          });
        case "extension_error":
          return Effect.succeed<BackendEvent>({
            type: "warning",
            source: "runtime-extension",
            message: envelope.error,
          });
        case "extension_ui_request":
          return noBackendEvent;
      }
    }),
    Effect.catch(() =>
      Effect.succeed<BackendEvent>({
        type: "protocol_error",
        message: "Subagent emitted an invalid protocol event.",
      }),
    ),
  );

interface LocalPiResumeToken extends BackendResumeToken {
  readonly type: "local-pi-session-file";
  readonly sessionFile: string;
}

const localPiResumeToken = (sessionFile: string): LocalPiResumeToken => ({
  type: "local-pi-session-file",
  sessionFile,
});

// SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
const decodeLocalPiResumeToken = (
  token: BackendResumeToken,
): Effect.Effect<LocalPiResumeToken, SubagentProtocolError> =>
  hasObjectRuntimeType(token) &&
  token !== null &&
  "type" in token &&
  token.type === "local-pi-session-file" &&
  "sessionFile" in token &&
  Predicate.isString(token.sessionFile) &&
  token.sessionFile.length > 0
    ? Effect.succeed(token as LocalPiResumeToken)
    : Effect.fail(protocolError("Local Pi received an invalid backend resume token."));

interface PendingRpcResponse {
  readonly command: string;
  readonly deferred: Deferred.Deferred<RpcResponse, SubagentError>;
}

interface PendingIpcAck {
  readonly deferred: Deferred.Deferred<void, SubagentError>;
}

const makeLocalPiHandle = Effect.fn("LocalPiBackend.makeHandle")(function* (
  child: ChildProcessHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const turnControl = yield* Semaphore.make(1);
  const withTurnControl = turnControl.withPermits(1);
  const responses = new Map<string, PendingRpcResponse>();
  const ipcAcks = new Map<string, PendingIpcAck>();
  const rawEventOwners = new Map<BackendEvent, ChildWireEvent>();
  let nextRpcId = 1;
  let nextIpcAckId = 1;
  let assignmentEpoch = 0;

  const acknowledgeRaw = (event: ChildWireEvent) => child.acknowledge?.(event);
  const acknowledge = (event: BackendEvent) => {
    const raw = rawEventOwners.get(event);
    if (!raw) return;
    rawEventOwners.delete(event);
    acknowledgeRaw(raw);
  };
  const acknowledgeAll = () => {
    for (const raw of rawEventOwners.values()) acknowledgeRaw(raw);
    rawEventOwners.clear();
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      acknowledgeAll();
      Queue.endUnsafe(events);
    }),
  );

  const cancelPending = (error: SubagentError) => {
    for (const response of responses.values())
      Deferred.doneUnsafe(response.deferred, Effect.fail(error));
    responses.clear();
    for (const pending of ipcAcks.values())
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    ipcAcks.clear();
  };

  const rpc = <A extends RpcCommand>(command: A): Effect.Effect<RpcResponse, SubagentError> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const id = `backend-rpc-${nextRpcId++}`;
        const response = Deferred.makeUnsafe<RpcResponse, SubagentError>();
        responses.set(id, { command: command.type, deferred: response });
        return { id, response };
      }),
      ({ id, response }) =>
        Effect.raceFirst(
          child.send({ ...command, id }).pipe(
            Effect.mapError((error) => mapTransportUncertainty(command, error)),
            Effect.andThen(Deferred.await(response)),
          ),
          Deferred.await(response),
        ).pipe(
          Effect.timeoutOption(RPC_TIMEOUT),
          Effect.flatMap((outcome) =>
            Option.isSome(outcome)
              ? Effect.succeed(outcome.value)
              : Effect.fail(
                  new SubagentProcessError({
                    operation: "await RPC response from",
                    code: rpcOutcomeCode(command.type),
                    message:
                      command.type === "clear_queue"
                        ? "Subagent did not answer clear_queue; queue clearing may already have applied, but abort was not sent. Inspect subagent status before retrying interrupt."
                        : `Subagent did not answer ${command.type}; the command may already have applied. Inspect subagent status before retrying.`,
                  }),
                ),
          ),
          Effect.flatMap((response) =>
            response.success
              ? Effect.succeed(response)
              : Effect.fail(
                  new SubagentProcessError({
                    operation: `execute ${command.type} in`,
                    message: sanitizeDiagnosticText(
                      command.type === "clear_queue"
                        ? `${response.error ?? "Subagent RPC command clear_queue failed."} Abort was not sent.`
                        : (response.error ?? `Subagent RPC command ${command.type} failed.`),
                      MAX_ERROR_CHARS,
                    ),
                  }),
                ),
          ),
        ),
      ({ id }) =>
        Effect.sync(() => {
          responses.delete(id);
        }),
    );

  const offerEvent = (raw: ChildWireEvent, event: BackendEvent) =>
    Effect.suspend(() => {
      rawEventOwners.set(event, raw);
      const dropDiagnostic = (event: BackendEvent): Effect.Effect<void> =>
        // A dropped settlement/report degrades until process exit; make the loss
        // diagnosable instead of acknowledging it silently.
        Effect.logWarning(
          `Subagent local-Pi event ingress overflowed; dropped a ${event.type} event.`,
        ).pipe(Effect.andThen(Effect.sync(() => acknowledge(event))), Effect.asVoid);
      return Queue.offer(events, event).pipe(
        // A delivered offer settles inline; every other exit (ended queue, failure, defect,
        // interruption of a suspended offer) takes the same diagnostic path.
        Effect.flatMap((delivered) => (delivered ? Effect.void : dropDiagnostic(event))),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : dropDiagnostic(event))),
        Effect.asVoid,
      );
    });

  const consumeChildEvent = (event: ChildWireEvent): Effect.Effect<void> => {
    if (event.type === "protocol_error")
      return offerEvent(event, { type: "protocol_error", message: event.message });
    if (event.type === "parent_contact") {
      const contact = event.value;
      if (
        contact.type === "parent_reply_ack" ||
        contact.type === "proxy_notification_ack" ||
        contact.type === "turn_input_barrier_ack"
      ) {
        const pending = ipcAcks.get(contact.requestId);
        if (pending)
          Deferred.doneUnsafe(
            pending.deferred,
            contact.type === "turn_input_barrier_ack" || contact.ok
              ? Effect.void
              : Effect.fail(
                  new SubagentProcessError(
                    contact.type === "parent_reply_ack"
                      ? {
                          operation: "deliver parent reply to",
                          code: "question_ownership_mismatch",
                          message:
                            "Subagent no longer owns the parent question, so the reply was not applied.",
                        }
                      : {
                          operation: "deliver descendant notification to",
                          code: "transport_not_sent",
                          message:
                            "Subagent rejected a descendant notification before queueing it.",
                        },
                  ),
                ),
          );
        acknowledgeRaw(event);
        return Effect.void;
      }
      const normalized: BackendEvent = (() => {
        switch (contact.type) {
          case "contact_parent":
            return {
              type: "supervisor_contact",
              assignmentEpoch,
              requestId: contact.requestId,
              kind: contact.kind,
              message: contact.message,
            };
          case "contact_cancel":
            return {
              type: "supervisor_question_cancelled",
              assignmentEpoch,
              requestId: contact.requestId,
            };
          case "proxy_request":
            return {
              type: "proxy_request",
              requestId: contact.requestId,
              tool: contact.tool,
              argumentsJson: contact.argumentsJson,
              respond: (ok, payloadJson) =>
                child.sendContactControl({
                  channel: "pi-subagents",
                  type: "proxy_response",
                  requestId: contact.requestId,
                  ok,
                  payloadJson,
                }),
            };
          case "proxy_cancel":
            return { type: "proxy_cancel", requestId: contact.requestId };
        }
      })();
      return offerEvent(event, normalized);
    }
    if (event.type === "exit")
      return Effect.sync(() => {
        acknowledgeRaw(event);
      });
    return decodeRpcEnvelope(event.value).pipe(
      Effect.flatMap((envelope) => {
        if (envelope.type === "response") {
          const pending = envelope.id ? responses.get(envelope.id) : undefined;
          if (!pending) {
            acknowledgeRaw(event);
            return Effect.void;
          }
          if (pending.command !== envelope.command) {
            const error = protocolError(
              `Subagent RPC response command did not match ${pending.command}.`,
            );
            Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
            return offerEvent(event, {
              type: "protocol_error",
              message: "Subagent returned a mismatched RPC response command.",
            });
          }
          Deferred.doneUnsafe(pending.deferred, Effect.succeed(envelope));
          acknowledgeRaw(event);
          return Effect.void;
        }
        if (envelope.type === "extension_ui_request")
          return child
            .send({
              type: "extension_ui_response",
              id: envelope.id,
              cancelled: true,
            })
            .pipe(
              Effect.catch(() => Effect.void),
              Effect.ensuring(Effect.sync(() => acknowledgeRaw(event))),
            );
        const eventAssignmentEpoch = assignmentEpoch;
        return normalizeRpcEvent(event.value, eventAssignmentEpoch).pipe(
          Effect.flatMap((normalized) => {
            if (normalized) return offerEvent(event, normalized);
            acknowledgeRaw(event);
            return Effect.void;
          }),
        );
      }),
      Effect.catch(() =>
        offerEvent(event, {
          type: "protocol_error",
          message: "Subagent emitted an invalid protocol event.",
        }),
      ),
    );
  };

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeChildEvent),
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(
      Effect.sync(() => {
        cancelPending(
          new SubagentProcessError({
            operation: "run",
            message: "Subagent backend transport closed.",
          }),
        );
        Queue.endUnsafe(events);
      }),
    ),
    Effect.forkScoped,
  );

  const controls = {
    initialize: rpc({ type: "get_state" }).pipe(
      Effect.flatMap((response) =>
        decodeRpcStateData(response.data).pipe(
          Effect.mapError(() => protocolError("Subagent returned invalid startup state.")),
        ),
      ),
      Effect.map((state) =>
        (() => {
          const baseResult = {};
          const withModel = rpcStateModelId(state.model)
            ? { ...baseResult, model: rpcStateModelId(state.model) }
            : baseResult;
          const withEffortAndSessionId = {
            ...withModel,
            effort: state.thinkingLevel,
            sessionId: state.sessionId,
          };
          const withSessionFileAndResumeToken = state.sessionFile
            ? {
                ...withEffortAndSessionId,
                sessionFile: state.sessionFile,
                resumeToken: localPiResumeToken(state.sessionFile),
              }
            : withEffortAndSessionId;
          return withSessionFileAndResumeToken;
        })(),
      ),
    ),
    start: (message: string, nextAssignmentEpoch: number) =>
      Effect.suspend(() => {
        const previousAssignmentEpoch = assignmentEpoch;
        assignmentEpoch = nextAssignmentEpoch;
        return rpc({ type: "prompt", message }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              const outcomeUncertain =
                error._tag === "SubagentProcessError" && isOutcomeUncertain(error);
              if (!outcomeUncertain && assignmentEpoch === nextAssignmentEpoch)
                assignmentEpoch = previousAssignmentEpoch;
            }),
          ),
          Effect.asVoid,
        );
      }),
    steer: (message: string) =>
      withTurnControl(rpc({ type: "steer", message }).pipe(Effect.asVoid)),
    interrupt: withTurnControl(
      Effect.gen(function* () {
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const requestId = `turn-input-barrier-${nextIpcAckId++}`;
            const deferred = Deferred.makeUnsafe<void, SubagentError>();
            ipcAcks.set(requestId, { deferred });
            return { requestId, deferred };
          }),
          ({ requestId, deferred }) =>
            Effect.raceFirst(
              child
                .sendContactControl({
                  channel: "pi-subagents",
                  type: "turn_input_barrier",
                  requestId,
                })
                .pipe(
                  Effect.catch((error) =>
                    isOutcomeUncertain(error) ? Effect.void : Effect.fail(error),
                  ),
                  Effect.andThen(Deferred.await(deferred)),
                ),
              Deferred.await(deferred),
            ).pipe(
              Effect.timeoutOption(RPC_TIMEOUT),
              Effect.flatMap((outcome) =>
                Option.isSome(outcome)
                  ? Effect.void
                  : Effect.fail(
                      new SubagentProcessError({
                        operation: "await turn-input barrier acknowledgment from",
                        code: "turn_input_barrier_unconfirmed",
                        message:
                          "Subagent did not acknowledge the turn-input barrier; queue clearing and abort were not sent.",
                      }),
                    ),
              ),
            ),
          ({ requestId }) =>
            Effect.sync(() => {
              ipcAcks.delete(requestId);
            }),
        );
        yield* rpc({ type: "clear_queue" });
        yield* rpc({ type: "abort" });
      }),
    ),
    renameDisplay: (name: string) => rpc({ type: "set_session_name", name }).pipe(Effect.asVoid),
    reply: (requestId: string, message: string) =>
      withTurnControl(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const ackId = `parent-reply-${nextIpcAckId++}`;
            const deferred = Deferred.makeUnsafe<void, SubagentError>();
            ipcAcks.set(ackId, { deferred });
            return { ackId, deferred };
          }),
          ({ ackId, deferred }) =>
            Effect.raceFirst(
              child
                .sendContactControl({
                  channel: "pi-subagents",
                  type: "parent_reply",
                  requestId,
                  ackId,
                  message,
                })
                .pipe(
                  Effect.catch((error) =>
                    isOutcomeUncertain(error) ? Effect.void : Effect.fail(error),
                  ),
                  Effect.andThen(Deferred.await(deferred)),
                ),
              Deferred.await(deferred),
            ).pipe(
              Effect.timeoutOption(RPC_TIMEOUT),
              Effect.flatMap((outcome) =>
                Option.isSome(outcome)
                  ? Effect.void
                  : Effect.fail(
                      new SubagentProcessError({
                        operation: "await parent reply acknowledgment from",
                        code: "reply_outcome_uncertain",
                        message:
                          "Subagent did not acknowledge the parent reply; it may already have applied.",
                      }),
                    ),
              ),
            ),
          ({ ackId }) =>
            Effect.sync(() => {
              ipcAcks.delete(ackId);
            }),
        ),
      ),
    notifyPeers: (message: string) =>
      child.sendContactControl({ channel: "pi-subagents", type: "peer_notice", message }),
    deliverNotification: (message: string) =>
      withTurnControl(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const requestId = `notification-${nextIpcAckId++}`;
            const deferred = Deferred.makeUnsafe<void, SubagentError>();
            ipcAcks.set(requestId, { deferred });
            return { requestId, deferred };
          }),
          ({ requestId, deferred }) =>
            Effect.raceFirst(
              child
                .sendContactControl({
                  channel: "pi-subagents",
                  type: "proxy_notification",
                  requestId,
                  message,
                })
                .pipe(
                  Effect.catch((error) =>
                    isOutcomeUncertain(error) ? Effect.void : Effect.fail(error),
                  ),
                  Effect.andThen(Deferred.await(deferred)),
                ),
              Deferred.await(deferred),
            ).pipe(
              Effect.timeoutOption(RPC_TIMEOUT),
              Effect.flatMap((outcome) =>
                Option.isSome(outcome)
                  ? Effect.void
                  : Effect.fail(
                      new SubagentProcessError({
                        operation: "await descendant notification acknowledgment from",
                        code: "transport_outcome_uncertain",
                        message:
                          "Subagent did not acknowledge the descendant notification; it may already be queued.",
                      }),
                    ),
              ),
            ),
          ({ requestId }) =>
            Effect.sync(() => {
              ipcAcks.delete(requestId);
            }),
        ),
      ),
  };

  return {
    pid: child.pid,
    events,
    awaitExit: child.awaitExit.pipe(
      Effect.map(toBackendExit),
      Effect.tapError((error) => Effect.sync(() => cancelPending(error))),
    ),
    controls,
    acknowledge,
    terminate: child.terminate,
    cancelPending,
  };
});

export const makeLocalPiBackendDriver = (childProcesses: ChildProcessContract): BackendDriver => ({
  host: "local",
  runtime: "pi",
  capabilities: PI_SUBAGENT_CAPABILITIES,
  supportsContext: (context) => context === "fresh" || context === "fork",
  preflight: (request) =>
    isSafeNativeModelSelector(request.model)
      ? Effect.void
      : Effect.fail(
          new InvalidSubagentRequestError({
            code: "pi_model_unsupported",
            message: "Pi model selector is empty, excessive, or unsafe.",
          }),
        ),
  spawn: (request: BackendLaunchRequest) =>
    Effect.gen(function* () {
      const resumeSessionFile = request.resumeToken
        ? (yield* decodeLocalPiResumeToken(request.resumeToken)).sessionFile
        : undefined;
      const childRequest: ChildLaunchRequest = (() => {
        const baseResult = {
          runId: request.runId,
          name: request.name,
          cwd: request.cwd,
          context: request.context,
          writeIntent: request.writeIntent,
          openaiFastMode: request.openaiFastMode,
          model: request.model,
          effort: request.effort,
        };
        const withRuntimeApiKey = request.runtimeApiKey
          ? { ...baseResult, runtimeApiKey: request.runtimeApiKey }
          : baseResult;
        const withActiveToolsAndAdditionalFields = {
          ...withRuntimeApiKey,
          activeTools: request.activeTools,
          projectTrusted: request.projectTrusted,
          parentSessionId: request.parentSessionId,
        };
        const withParentSessionFile = request.parentSessionFile
          ? { ...withActiveToolsAndAdditionalFields, parentSessionFile: request.parentSessionFile }
          : withActiveToolsAndAdditionalFields;
        const withParentLeafId = request.parentLeafId
          ? { ...withParentSessionFile, parentLeafId: request.parentLeafId }
          : withParentSessionFile;
        const withResumeSessionFile = resumeSessionFile
          ? { ...withParentLeafId, resumeSessionFile }
          : withParentLeafId;
        const withSystemPrompt = { ...withResumeSessionFile, systemPrompt: request.systemPrompt };
        return withSystemPrompt;
      })();
      const child = yield* childProcesses.spawn(childRequest);
      return yield* makeLocalPiHandle(child);
    }),
  reclaimRunState: (request) => childProcesses.reclaimRunState(request),
});
