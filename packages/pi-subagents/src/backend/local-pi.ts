import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  type ChildLaunchRequest,
  type ChildProcessHandle,
  type ChildProcessShape,
  type ChildWireEvent,
} from "../boundary/child-process.ts";
import {
  InvalidSubagentRequestError,
  SubagentProcessError,
  SubagentProtocolError,
  type SubagentError,
} from "../run/errors.ts";
import { PI_SUBAGENT_CAPABILITIES, type SubagentUsage } from "../run/model.ts";
import { isSafeNativeModelSelector } from "../run/native-model-selector.ts";
import {
  assistantText,
  decodeAssistantMessage,
  decodeContactParentEnvelope,
  decodeRpcEnvelope,
  decodeRpcStateData,
  decodeRpcUsageOption,
  rpcStateModelId,
  type RpcCommand,
  type RpcResponse,
} from "./local-pi-protocol.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "../run/state.ts";
import type {
  BackendDriver,
  BackendEvent,
  BackendLaunchRequest,
  BackendResumeToken,
} from "./model.ts";

const RPC_TIMEOUT = "10 seconds";
const EVENT_CAPACITY = 512;

const protocolError = (message: string) => new SubagentProtocolError({ message });
const noBackendEvent: Effect.Effect<BackendEvent | undefined> = Effect.as(Effect.void, undefined);
const usageFromRpc = (usage: ReturnType<typeof decodeRpcUsageOption>): SubagentUsage => ({
  input: usage?.input ?? 0,
  output: usage?.output ?? 0,
  cacheRead: usage?.cacheRead ?? 0,
  cacheWrite: usage?.cacheWrite ?? 0,
  totalTokens: usage?.totalTokens ?? 0,
  // Pi reports a known client-side cost total; absence remains unknown, never $0.
  ...(usage?.cost?.total === undefined ? {} : { cost: usage.cost.total }),
});

const rpcOutcomeCode = (command: string): string => {
  switch (command) {
    case "steer":
      return "guidance_outcome_uncertain";
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
        message: `${error.message} Inspect subagent status before retrying ${command.type}.`,
      })
    : error;

const normalizeRpcEvent = (value: unknown, assignmentEpoch: number) =>
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
                ? {
                    type: "assistant_message" as const,
                    assignmentEpoch,
                    ...(assistantText(message) ? { text: assistantText(message) } : {}),
                    usage: usageFromRpc(decodeRpcUsageOption(message.usage)),
                  }
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

const normalizeIpcEvent = (value: unknown, assignmentEpoch: number): Effect.Effect<BackendEvent> =>
  decodeContactParentEnvelope(value).pipe(
    Effect.map((envelope) => ({
      type: "supervisor_contact" as const,
      assignmentEpoch,
      requestId: envelope.requestId,
      kind: envelope.kind,
      message: envelope.message,
    })),
    Effect.catch(() =>
      Effect.succeed<BackendEvent>({
        type: "protocol_error",
        message: "Subagent emitted an invalid parent-contact event.",
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

const decodeLocalPiResumeToken = (
  token: BackendResumeToken,
): Effect.Effect<LocalPiResumeToken, SubagentProtocolError> =>
  typeof token === "object" &&
  token !== null &&
  "type" in token &&
  token.type === "local-pi-session-file" &&
  "sessionFile" in token &&
  typeof token.sessionFile === "string" &&
  token.sessionFile.length > 0
    ? Effect.succeed(token as LocalPiResumeToken)
    : Effect.fail(protocolError("Local Pi received an invalid backend resume token."));

interface PendingRpcResponse {
  readonly command: string;
  readonly deferred: Deferred.Deferred<RpcResponse, SubagentError>;
}

const makeLocalPiHandle = Effect.fn("LocalPiBackend.makeHandle")(function* (
  child: ChildProcessHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const responses = new Map<string, PendingRpcResponse>();
  const rawEventOwners = new Map<BackendEvent, ChildWireEvent>();
  let nextRpcId = 1;
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
                    message: `Subagent did not answer ${command.type}; the command may already have applied. Inspect subagent status before retrying.`,
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
                      response.error ?? `Subagent RPC command ${command.type} failed.`,
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
      let offered = false;
      return Queue.offer(events, event).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            offered = true;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (!offered) acknowledge(event);
          }),
        ),
        Effect.asVoid,
      );
    });

  const consumeChildEvent = (event: ChildWireEvent): Effect.Effect<void> => {
    if (event.type === "protocol_error")
      return offerEvent(event, { type: "protocol_error", message: event.message });
    if (event.type === "ipc_message") {
      const eventAssignmentEpoch = assignmentEpoch;
      return normalizeIpcEvent(event.value, eventAssignmentEpoch).pipe(
        Effect.flatMap((normalized) => offerEvent(event, normalized)),
      );
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
      Effect.map((state) => ({
        ...(rpcStateModelId(state.model) ? { model: rpcStateModelId(state.model) } : {}),
        effort: state.thinkingLevel,
        sessionId: state.sessionId,
        ...(state.sessionFile
          ? {
              sessionFile: state.sessionFile,
              resumeToken: localPiResumeToken(state.sessionFile),
            }
          : {}),
      })),
    ),
    start: (message: string, nextAssignmentEpoch: number) =>
      Effect.suspend(() => {
        const previousAssignmentEpoch = assignmentEpoch;
        assignmentEpoch = nextAssignmentEpoch;
        return rpc({ type: "prompt", message }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              const outcomeUncertain =
                error._tag === "SubagentProcessError" &&
                error.code?.endsWith("_outcome_uncertain") === true;
              if (!outcomeUncertain && assignmentEpoch === nextAssignmentEpoch)
                assignmentEpoch = previousAssignmentEpoch;
            }),
          ),
          Effect.asVoid,
        );
      }),
    steer: (message: string) => rpc({ type: "steer", message }).pipe(Effect.asVoid),
    interrupt: rpc({ type: "abort" }).pipe(Effect.asVoid),
    renameDisplay: (name: string) => rpc({ type: "set_session_name", name }).pipe(Effect.asVoid),
    reply: (requestId: string, message: string) =>
      child.sendIpc({
        channel: "pi-subagents",
        type: "parent_reply",
        requestId,
        message,
      }),
    notifyPeers: (message: string) =>
      child.sendIpc({ channel: "pi-subagents", type: "peer_notice", message }),
  };

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
      Effect.tapError((error) => Effect.sync(() => cancelPending(error))),
    ),
    controls,
    acknowledge,
    terminate: child.terminate,
    cancelPending,
  };
});

export const makeLocalPiBackendDriver = (childProcesses: ChildProcessShape): BackendDriver => ({
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
      const childRequest: ChildLaunchRequest = {
        runId: request.runId,
        name: request.name,
        cwd: request.cwd,
        context: request.context,
        writeIntent: request.writeIntent,
        fastMode: request.fastMode,
        model: request.model,
        effort: request.effort,
        ...(request.runtimeApiKey ? { runtimeApiKey: request.runtimeApiKey } : {}),
        activeTools: request.activeTools,
        projectTrusted: request.projectTrusted,
        parentSessionId: request.parentSessionId,
        ...(request.parentSessionFile ? { parentSessionFile: request.parentSessionFile } : {}),
        ...(request.parentLeafId ? { parentLeafId: request.parentLeafId } : {}),
        ...(resumeSessionFile ? { resumeSessionFile } : {}),
        systemPrompt: request.systemPrompt,
      };
      const child = yield* childProcesses.spawn(childRequest);
      return yield* makeLocalPiHandle(child);
    }),
  reclaimRunState: (request) => childProcesses.reclaimRunState(request),
});
