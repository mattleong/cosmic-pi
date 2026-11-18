import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { ChildProcessHandle } from "../boundary/child-process.ts";
import {
  appendShared,
  errorText,
  isOutcomeUncertain,
  processError,
  SubagentProcessError,
  withGuidance,
  type GuidedText,
  type SubagentError,
} from "../run/errors.ts";
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

const appendQueueNote = (text: GuidedText): GuidedText =>
  appendShared(text, " Queue clearing could not be confirmed; abort was not sent.");

const mapTransportUncertainty = (command: RpcCommand, error: SubagentError): SubagentError =>
  Predicate.isTagged(error, "SubagentProcessError") && error.code === "transport_outcome_uncertain"
    ? processError(
        `execute ${command.type} in`,
        rpcOutcomeCode(command),
        command.type === "clear_queue"
          ? withGuidance(
              appendQueueNote(errorText(error)),
              "Inspect the run with agent_read before retrying interrupt.",
            )
          : withGuidance(
              errorText(error),
              `Inspect the run with agent_read before retrying ${commandLabel(command)}.`,
            ),
      )
    : error;

type RpcResponseResolution = "unmatched" | "mismatched" | "resolved";

interface RpcResponseHeader {
  readonly id?: string | undefined;
  readonly command: string;
}

interface PendingRpcResponse {
  readonly command: string;
  readonly deferred: Deferred.Deferred<RpcResponse, SubagentError>;
  readonly onResponse?: ((response: RpcResponse) => void) | undefined;
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

  /**
   * `onResponse` runs where the child's reply is read, before any later child event, so a caller
   * can act on the reply at its exact place in the stream.
   */
  const rpc = (
    command: RpcCommand,
    timeout: Duration.Input = RPC_TIMEOUT,
    onResponse?: (response: RpcResponse) => void,
  ): Effect.Effect<RpcResponse, SubagentError> =>
    correlatedRequest<string, RpcResponse>({
      timeout,
      register: (deferred) => {
        const id = `backend-rpc-${nextRpcId++}`;
        responses.set(id, { command: command.type, deferred, onResponse });
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
        processError(
          "await RPC response from",
          rpcOutcomeCode(command),
          command.type === "clear_queue"
            ? withGuidance(
                "Subagent did not answer clear_queue; queue clearing may already have applied, but abort was not sent.",
                "Inspect the run with agent_read before retrying interrupt.",
              )
            : withGuidance(
                `Subagent did not answer ${commandLabel(command)}; the command may already have applied.`,
                "Inspect the run with agent_read before retrying.",
              ),
        ),
    }).pipe(
      Effect.filterOrFail(
        (response) => response.success,
        (response) =>
          SubagentProcessError.make({
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
    });

  const resolveIpcAck = (requestId: string, outcome: Effect.Effect<void, SubagentError>) => {
    const deferred = ipcAcks.get(requestId);
    if (deferred) Deferred.doneUnsafe(deferred, outcome);
  };

  const settleResponse = (
    header: RpcResponseHeader,
    settle: (pending: PendingRpcResponse) => void,
  ): RpcResponseResolution => {
    const pending = header.id ? responses.get(header.id) : undefined;
    if (!pending) return "unmatched";
    if (pending.command !== header.command) {
      const error = protocolError(
        `Subagent RPC response command did not match ${pending.command}.`,
      );
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
      return "mismatched";
    }
    settle(pending);
    return "resolved";
  };

  const resolveResponse = (envelope: RpcResponse): RpcResponseResolution =>
    settleResponse(envelope, (pending) => {
      pending.onResponse?.(envelope);
      Deferred.doneUnsafe(pending.deferred, Effect.succeed(envelope));
    });

  /** Fails the request a reply answers when the reply itself can't be read, such as one too large to carry. */
  const rejectResponse = (header: RpcResponseHeader, error: SubagentError): RpcResponseResolution =>
    settleResponse(header, (pending) => {
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    });

  return { rpc, ipcAck, resolveIpcAck, resolveResponse, rejectResponse, cancel };
};
