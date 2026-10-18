import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ChildProcessHandle } from "../boundary/child-process.ts";
import { isOutcomeUncertain, SubagentProcessError, type SubagentError } from "../run/errors.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "../run/state.ts";
import { correlatedRequest, protocolError } from "./driver-shared.ts";
import type { LocalPiParentControl, RpcCommand, RpcResponse } from "./local-pi-protocol.ts";

const RPC_TIMEOUT = "10 seconds";

const RPC_OUTCOME_CODES = new Map<RpcCommand["type"], string>([
  ["abort", "interrupt_outcome_uncertain"],
]);

const isGuidance = (command: RpcCommand): boolean =>
  command.type === "prompt" && command.streamingBehavior === "steer";

const commandLabel = (command: RpcCommand): string =>
  isGuidance(command) ? "guidance" : command.type;

const rpcOutcomeCode = (command: RpcCommand): string =>
  isGuidance(command)
    ? "guidance_outcome_uncertain"
    : (RPC_OUTCOME_CODES.get(command.type) ?? `${command.type}_outcome_uncertain`);

const mapTransportUncertainty = (command: RpcCommand, error: SubagentError): SubagentError =>
  Predicate.isTagged(error, "SubagentProcessError") && error.code === "transport_outcome_uncertain"
    ? new SubagentProcessError({
        operation: `execute ${command.type} in`,
        code: rpcOutcomeCode(command),
        message:
          command.type === "clear_queue"
            ? `${error.message} Queue clearing could not be confirmed; abort was not sent. Inspect subagent status before retrying interrupt.`
            : `${error.message} Inspect subagent status before retrying ${commandLabel(command)}.`,
      })
    : error;

interface PendingRpcResponse {
  readonly command: string;
  readonly deferred: Deferred.Deferred<RpcResponse, SubagentError>;
}

export const localPiRpc = (child: Pick<ChildProcessHandle, "send" | "sendContactControl">) => {
  const responses = new Map<string, PendingRpcResponse>();
  const ipcAcks = new Map<string, Deferred.Deferred<void, SubagentError>>();
  let nextRpcId = 1;
  let nextIpcAckId = 1;

  const cancel = (error: SubagentError) => {
    for (const response of responses.values())
      Deferred.doneUnsafe(response.deferred, Effect.fail(error));
    responses.clear();
    for (const deferred of ipcAcks.values()) Deferred.doneUnsafe(deferred, Effect.fail(error));
    ipcAcks.clear();
  };

  const rpc = (
    command: RpcCommand,
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
          code: rpcOutcomeCode(command),
          message:
            command.type === "clear_queue"
              ? "Subagent did not answer clear_queue; queue clearing may already have applied, but abort was not sent. Inspect subagent status before retrying interrupt."
              : `Subagent did not answer ${commandLabel(command)}; the command may already have applied. Inspect subagent status before retrying.`,
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

  const resolveIpcAck = (requestId: string, outcome: Effect.Effect<void, SubagentError>) => {
    const deferred = ipcAcks.get(requestId);
    if (deferred) Deferred.doneUnsafe(deferred, outcome);
  };

  const resolveResponse = (envelope: RpcResponse): "unmatched" | "mismatched" | "resolved" => {
    const pending = envelope.id ? responses.get(envelope.id) : undefined;
    if (!pending) return "unmatched";
    if (pending.command !== envelope.command) {
      const error = protocolError(
        `Subagent RPC response command did not match ${pending.command}.`,
      );
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
      return "mismatched";
    }
    Deferred.doneUnsafe(pending.deferred, Effect.succeed(envelope));
    return "resolved";
  };

  return { rpc, ipcAck, resolveIpcAck, resolveResponse, cancel };
};
