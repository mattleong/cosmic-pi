import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { makeLocalCliRawEventOwnership } from "./local-cli-events.ts";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  type ChildProcessHandle,
  type ChildProcessContract,
  type ChildWireEvent,
} from "../boundary/child-process.ts";
import {
  InvalidSubagentRequestError,
  isOutcomeUncertain,
  SubagentProcessError,
  type SubagentError,
} from "../run/errors.ts";
import { PI_SUBAGENT_CAPABILITIES, emptyUsage } from "../run/model.ts";
import { makeLocalPiUsage } from "./local-pi-usage.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import {
  assistantText,
  decodeAssistantMessage,
  decodeRpcEnvelope,
  decodeRpcStateData,
  MAX_STRUCTURED_RESULT_REJECTION_CHARS,
  rpcStateModelId,
  type LocalPiParentControl,
  type RpcChildEnvelope,
  type RpcCommand,
  type RpcResponse,
} from "./local-pi-protocol.ts";
import {
  MAX_ERROR_CHARS,
  MAX_FINAL_TEXT_CHARS,
  safeTextPrefix,
  sanitizeStreamDiagnostic,
  sanitizeDiagnosticText,
  sanitizeOutputText,
} from "../run/state.ts";
import { correlatedRequest, protocolError } from "./driver-shared.ts";
import {
  toBackendExit,
  type BackendAssistantTerminal,
  type BackendDriver,
  type BackendEvent,
  type BackendLaunchRequest,
  type BackendResumeToken,
} from "./model.ts";

const RPC_TIMEOUT = "10 seconds";
// Process spawn precedes Pi model/resource loading and extension startup.
const STARTUP_RPC_TIMEOUT = "30 seconds";
const EVENT_CAPACITY = 512;

const noBackendEvent: Effect.Effect<BackendEvent | undefined> = Effect.as(Effect.void, undefined);

const RPC_OUTCOME_CODES = new Map<RpcCommand["type"], string>([
  ["steer", "guidance_outcome_uncertain"],
  ["abort", "interrupt_outcome_uncertain"],
  ["set_session_name", "rename_outcome_uncertain"],
]);
const rpcOutcomeCode = (command: RpcCommand["type"]): string =>
  RPC_OUTCOME_CODES.get(command) ?? `${command}_outcome_uncertain`;

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

const normalizeRpcEvent = (
  envelope: RpcChildEnvelope,
  assignmentEpoch: number,
): Effect.Effect<BackendEvent | undefined, Schema.SchemaError> => {
  switch (envelope.type) {
    case "agent_start":
      return Effect.succeed<BackendEvent>({ type: "run_started", assignmentEpoch });
    case "agent_settled":
      return Effect.succeed<BackendEvent>({ type: "run_settled", assignmentEpoch });
    case "message_update":
      return Effect.succeed(
        envelope.assistantMessageEvent.type === "text_delta" && envelope.assistantMessageEvent.delta
          ? ({ type: "activity", assignmentEpoch } as const)
          : undefined,
      );
    case "message_end":
      return decodeAssistantMessage(envelope.message).pipe(
        Effect.map((message): BackendEvent | undefined => {
          if (!message) return undefined;
          const text = sanitizeOutputText(assistantText(message), MAX_FINAL_TEXT_CHARS);
          return {
            type: "assistant_message",
            assignmentEpoch,
            ...(text && { text }),
            usage: emptyUsage(),
            terminal: {
              stopReason: message.stopReason,
              text,
              ...(message.errorMessage && {
                errorMessage: sanitizeDiagnosticText(message.errorMessage, MAX_ERROR_CHARS),
              }),
            },
          };
        }),
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
    default:
      return noBackendEvent;
  }
};

const LocalPiResumeToken = Schema.Struct({
  type: Schema.Literal("local-pi-session-file"),
  sessionFile: Schema.String.check(Schema.isMinLength(1)),
});

const localPiResumeToken = (sessionFile: string): typeof LocalPiResumeToken.Type => ({
  type: "local-pi-session-file",
  sessionFile,
});

const decodeLocalPiResumeToken = (token: BackendResumeToken) =>
  Schema.decodeUnknownEffect(LocalPiResumeToken)(token).pipe(
    Effect.mapError(() => protocolError("Local Pi received an invalid backend resume token.")),
  );

interface PendingRpcResponse {
  readonly command: string;
  readonly deferred: Deferred.Deferred<RpcResponse, SubagentError>;
}

const makeLocalPiHandle = Effect.fn("LocalPiBackend.makeHandle")(function* (
  child: ChildProcessHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const turnControl = yield* Semaphore.make(1);
  const withTurnControl = turnControl.withPermits(1);
  const responses = new Map<string, PendingRpcResponse>();
  const ipcAcks = new Map<string, Deferred.Deferred<void, SubagentError>>();
  let nextRpcId = 1;
  let nextIpcAckId = 1;
  let assignmentEpoch = 0;
  let latestTerminal: BackendAssistantTerminal | undefined;
  let transportFailure: SubagentError | undefined;

  const { offer, release, acknowledge, acknowledgeAll } = makeLocalCliRawEventOwnership(
    events,
    (event: ChildWireEvent) => child.acknowledge?.(event),
    "local-Pi",
  );
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
    for (const deferred of ipcAcks.values()) Deferred.doneUnsafe(deferred, Effect.fail(error));
    ipcAcks.clear();
  };

  const awaitExit = child.awaitExit.pipe(
    Effect.map((exit) => {
      const summary = `Subagent process exited${exit.exitCode === null ? "" : ` with code ${exit.exitCode}`}${exit.signal ? ` (${exit.signal})` : ""}.`;
      const stderr = exit.stderr.trim();
      return {
        ...toBackendExit(exit),
        diagnostic: stderr
          ? `${summary} ${sanitizeStreamDiagnostic(stderr, MAX_ERROR_CHARS - summary.length - 1)}`
          : summary,
      };
    }),
    Effect.tapError((error) =>
      Effect.sync(() => {
        transportFailure = error;
        cancelPending(error);
      }),
    ),
  );

  const rpc = <A extends RpcCommand>(
    command: A,
    timeout: Duration.Input = RPC_TIMEOUT,
  ): Effect.Effect<RpcResponse, SubagentError> =>
    correlatedRequest<string, RpcResponse>({
      timeout,
      register: (deferred) => {
        const id = `backend-rpc-${nextRpcId++}`;
        responses.set(id, { command: command.type, deferred });
        return {
          frame: id,
          unregister: Effect.sync(() => {
            responses.delete(id);
          }),
        };
      },
      send: (id) =>
        child
          .send({ ...command, id })
          .pipe(Effect.mapError((error) => mapTransportUncertainty(command, error))),
      timeoutError: () =>
        new SubagentProcessError({
          operation: "await RPC response from",
          code: rpcOutcomeCode(command.type),
          message:
            command.type === "clear_queue"
              ? "Subagent did not answer clear_queue; queue clearing may already have applied, but abort was not sent. Inspect subagent status before retrying interrupt."
              : `Subagent did not answer ${command.type}; the command may already have applied. Inspect subagent status before retrying.`,
        }),
      awaitEarlyResponse: true,
    }).pipe(
      Effect.filterOrFail(
        (response) => response.success,
        (response) =>
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
    );

  const ipcAck = (
    idPrefix: string,
    makeControl: (id: string) => LocalPiParentControl,
    timeoutError: () => SubagentError,
  ): Effect.Effect<void, SubagentError> =>
    correlatedRequest({
      timeout: RPC_TIMEOUT,
      register: (deferred) => {
        const id = `${idPrefix}-${nextIpcAckId++}`;
        ipcAcks.set(id, deferred);
        return {
          frame: id,
          unregister: Effect.sync(() => {
            if (ipcAcks.get(id) === deferred) ipcAcks.delete(id);
          }),
        };
      },
      send: (id) =>
        child
          .sendContactControl(makeControl(id))
          .pipe(Effect.catchIf(isOutcomeUncertain, () => Effect.void)),
      timeoutError,
      awaitEarlyResponse: true,
    });

  const usageRequests = yield* Queue.dropping<void>(1);
  const accountUsage = makeLocalPiUsage();
  const usageControl = yield* Semaphore.make(1);
  const withUsageControl = usageControl.withPermits(1);
  let usageDirty = false;
  let usageReady = false;
  let pendingSettlement: Extract<BackendEvent, { type: "run_settled" }> | undefined;
  const reconcileUsage = Effect.gen(function* () {
    if (transportFailure) return yield* transportFailure;
    const response = yield* rpc({ type: "get_session_stats" });
    const usage = accountUsage.account(response.data);
    if (usage) yield* offer({ type: "usage", usage });
  });
  const requireUsageBaseline = Effect.suspend(() =>
    accountUsage.hasBaseline()
      ? Effect.void
      : Effect.fail(
          protocolError("Subagent did not provide valid startup usage totals; no prompt was sent."),
        ),
  );
  const drainUsage = Effect.gen(function* () {
    if (!usageReady) return;
    while (usageDirty || pendingSettlement) {
      usageDirty = false;
      const settlement = pendingSettlement;
      yield* reconcileUsage.pipe(Effect.catch(() => Effect.void));
      if (settlement && settlement === pendingSettlement) {
        pendingSettlement = undefined;
        if (settlement.assignmentEpoch === assignmentEpoch) yield* offer(settlement);
      }
    }
  });
  const requestUsage = () => {
    usageDirty = true;
    Queue.offerUnsafe(usageRequests, undefined);
  };
  yield* Stream.fromQueue(usageRequests).pipe(
    Stream.runForEach(() => withUsageControl(drainUsage)),
    Effect.forkScoped,
  );

  const consumeChildEvent = (event: ChildWireEvent): Effect.Effect<void> => {
    if (event.type === "protocol_error")
      return offer({ type: "protocol_error", message: event.message }, event);
    if (event.type === "parent_contact") {
      const contact = event.value;
      if (
        contact.type === "parent_reply_ack" ||
        contact.type === "proxy_notification_ack" ||
        contact.type === "turn_input_barrier_ack"
      ) {
        const deferred = ipcAcks.get(contact.requestId);
        if (deferred)
          Deferred.doneUnsafe(
            deferred,
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
        return release(event);
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
          case "structured_result":
            return {
              type: "structured_result",
              assignmentEpoch,
              requestId: contact.requestId,
              valueJson: contact.valueJson,
              respond: (ok, message) =>
                child.sendContactControl({
                  channel: "pi-subagents",
                  type: "structured_result_ack",
                  requestId: contact.requestId,
                  ok,
                  ...(message !== undefined && {
                    message: safeTextPrefix(message, MAX_STRUCTURED_RESULT_REJECTION_CHARS),
                  }),
                }),
            };
        }
      })();
      return offer(normalized, event);
    }
    if (event.type === "exit") return release(event);
    return decodeRpcEnvelope(event.value).pipe(
      Effect.flatMap((envelope) => {
        if (envelope.type === "response") {
          const pending = envelope.id ? responses.get(envelope.id) : undefined;
          if (!pending) return release(event);
          if (pending.command !== envelope.command) {
            const error = protocolError(
              `Subagent RPC response command did not match ${pending.command}.`,
            );
            Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
            return offer(
              {
                type: "protocol_error",
                message: "Subagent returned a mismatched RPC response command.",
              },
              event,
            );
          }
          Deferred.doneUnsafe(pending.deferred, Effect.succeed(envelope));
          return release(event);
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
              Effect.ensuring(release(event)),
            );
        if (
          envelope.type === "ignored" &&
          ["turn_end", "compaction_end", "entry_appended"].includes(envelope.eventType)
        )
          requestUsage();
        // A new attempt invalidates earlier success, including retries and queued continuations.
        if (
          envelope.type === "agent_start" ||
          (envelope.type === "message_start" && envelope.message.role === "assistant")
        ) {
          latestTerminal = undefined;
          pendingSettlement = undefined;
        }
        const eventAssignmentEpoch = assignmentEpoch;
        return normalizeRpcEvent(envelope, eventAssignmentEpoch).pipe(
          Effect.flatMap((normalized) => {
            if (normalized?.type === "assistant_message") latestTerminal = normalized.terminal;
            if (normalized?.type === "run_settled") {
              pendingSettlement = { ...normalized, terminal: latestTerminal };
              requestUsage();
              return release(event);
            }
            return normalized ? offer(normalized, event) : release(event);
          }),
        );
      }),
      Effect.catch(() =>
        offer(
          {
            type: "protocol_error",
            message: "Subagent emitted an invalid protocol event.",
          },
          event,
        ),
      ),
    );
  };

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeChildEvent),
    // Natural transport closure has an exit receipt. Reject RPC with that cause before the
    // fallback finalizer can erase it. Keep the wait interruptible: scope teardown need not
    // imply process exit, and must still cancel pending requests without waiting for one.
    Effect.andThen(awaitExit),
    Effect.tap((exit) =>
      Effect.sync(() => {
        transportFailure = new SubagentProcessError({ operation: "run", message: exit.diagnostic });
        cancelPending(transportFailure);
      }),
    ),
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(
      Effect.gen(function* () {
        transportFailure ??= new SubagentProcessError({
          operation: "run",
          message: "Subagent backend transport closed.",
        });
        cancelPending(transportFailure);
        yield* withUsageControl(drainUsage).pipe(
          Effect.interruptible,
          Effect.ensuring(Effect.sync(() => Queue.endUnsafe(events))),
        );
      }),
    ),
    Effect.forkScoped,
  );

  const controls = {
    initialize: rpc({ type: "get_state" }, STARTUP_RPC_TIMEOUT).pipe(
      Effect.flatMap((response) =>
        decodeRpcStateData(response.data).pipe(
          Effect.mapError(() => protocolError("Subagent returned invalid startup state.")),
        ),
      ),
      Effect.tap(() =>
        withUsageControl(
          reconcileUsage.pipe(
            Effect.andThen(requireUsageBaseline),
            Effect.andThen(
              Effect.sync(() => {
                usageReady = true;
              }),
            ),
          ),
        ),
      ),
      Effect.map((state) => {
        const model = rpcStateModelId(state.model);
        return {
          ...(model && { model }),
          effort: state.thinkingLevel,
          sessionId: state.sessionId,
          ...(state.sessionFile && {
            sessionFile: state.sessionFile,
            resumeToken: localPiResumeToken(state.sessionFile),
          }),
        };
      }),
    ),
    start: (message: string, nextAssignmentEpoch: number) =>
      requireUsageBaseline.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const previousAssignmentEpoch = assignmentEpoch;
            const previousTerminal = latestTerminal;
            assignmentEpoch = nextAssignmentEpoch;
            latestTerminal = undefined;
            return rpc({ type: "prompt", message }).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  const outcomeUncertain =
                    error._tag === "SubagentProcessError" && isOutcomeUncertain(error);
                  if (!outcomeUncertain && assignmentEpoch === nextAssignmentEpoch) {
                    assignmentEpoch = previousAssignmentEpoch;
                    latestTerminal = previousTerminal;
                  }
                }),
              ),
              Effect.asVoid,
            );
          }),
        ),
      ),
    steer: (message: string) =>
      withTurnControl(rpc({ type: "steer", message }).pipe(Effect.asVoid)),
    interrupt: withTurnControl(
      Effect.gen(function* () {
        yield* ipcAck(
          "turn-input-barrier",
          (requestId) => ({
            channel: "pi-subagents",
            type: "turn_input_barrier",
            requestId,
          }),
          () =>
            new SubagentProcessError({
              operation: "await turn-input barrier acknowledgment from",
              code: "turn_input_barrier_unconfirmed",
              message:
                "Subagent did not acknowledge the turn-input barrier; queue clearing and abort were not sent.",
            }),
        );
        yield* rpc({ type: "clear_queue" });
        yield* rpc({ type: "abort" });
      }),
    ),
    renameDisplay: (name: string) => rpc({ type: "set_session_name", name }).pipe(Effect.asVoid),
    reply: (requestId: string, message: string) =>
      withTurnControl(
        ipcAck(
          "parent-reply",
          (ackId) => ({
            channel: "pi-subagents",
            type: "parent_reply",
            requestId,
            ackId,
            message,
          }),
          () =>
            new SubagentProcessError({
              operation: "await parent reply acknowledgment from",
              code: "reply_outcome_uncertain",
              message:
                "Subagent did not acknowledge the parent reply; it may already have applied.",
            }),
        ),
      ),
    notifyPeers: (message: string) =>
      child.sendContactControl({ channel: "pi-subagents", type: "peer_notice", message }),
    deliverNotification: (message: string) =>
      withTurnControl(
        ipcAck(
          "notification",
          (requestId) => ({
            channel: "pi-subagents",
            type: "proxy_notification",
            requestId,
            message,
          }),
          () =>
            new SubagentProcessError({
              operation: "await descendant notification acknowledgment from",
              code: "transport_outcome_uncertain",
              message:
                "Subagent did not acknowledge the descendant notification; it may already be queued.",
            }),
        ),
      ),
  };

  return {
    pid: child.pid,
    events,
    awaitExit,
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
      const { closeOnReport: _closeOnReport, resumeToken, ...launch } = request;
      const resumeSessionFile = resumeToken
        ? (yield* decodeLocalPiResumeToken(resumeToken)).sessionFile
        : undefined;
      const child = yield* childProcesses.spawn({
        ...launch,
        ...(resumeSessionFile && { resumeSessionFile }),
      });
      return yield* makeLocalPiHandle(child);
    }),
  reclaimRunState: (request) => childProcesses.reclaimRunState(request),
});
