import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { ChildProcessShape, ChildWireEvent } from "../boundary/child-process.ts";
import type { RunRecord } from "./internal.ts";
import type { SubagentError } from "./errors.ts";
import {
  InvalidSubagentRequestError,
  SubagentProcessError,
  SubagentProtocolError,
} from "./errors.ts";
import { hasSubagentCapability, isActiveRunState, isTerminalRunState } from "./model.ts";
import { peerNoticeText } from "./coordination.ts";
import {
  decodeRpcStateData,
  type PeerNotice,
  type RpcCommand,
  type RpcResponse,
  type RpcStateData,
} from "./protocol.ts";
import { MAX_ERROR_CHARS, sanitizeDiagnosticText } from "./state.ts";

const RPC_TIMEOUT = "10 seconds";

export interface RunProcessLifecycleDependencies {
  readonly childProcesses: ChildProcessShape;
  readonly ownerScope: Scope.Scope;
  readonly records: ReadonlyMap<string, RunRecord>;
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: () => void;
  readonly handleWireEvent: (
    record: RunRecord,
    event: ChildWireEvent,
  ) => Effect.Effect<void, SubagentError>;
  readonly markCleanupPending: (record: RunRecord) => Effect.Effect<void>;
  readonly closeExitedScope: (record: RunRecord, scope: Scope.Closeable) => Effect.Effect<void>;
  readonly failRun: (
    record: RunRecord,
    message: string,
    pendingError?: SubagentError,
  ) => Effect.Effect<unknown>;
}

const protocolError = (message: string) => new SubagentProtocolError({ message });

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

export function makeRunProcessLifecycle(dependencies: RunProcessLifecycleDependencies) {
  const {
    childProcesses,
    ownerScope,
    records,
    withLock,
    publish,
    handleWireEvent,
    markCleanupPending,
    closeExitedScope,
    failRun,
  } = dependencies;

  const rpc = <A extends RpcCommand>(record: RunRecord, command: A) =>
    Effect.gen(function* () {
      const response = yield* Deferred.make<RpcResponse, SubagentError>();
      const acquireRegistration = withLock(
        Effect.gen(function* () {
          const process = record.process;
          if (
            !process ||
            record.stoppedByParent ||
            record.cleanupPending ||
            record.view.state === "stopping" ||
            isTerminalRunState(record.view.state)
          )
            return yield* new SubagentProcessError({
              operation: "send RPC command to",
              message: `Subagent ${record.view.id} has no active process.`,
            });
          const id = `${record.view.id}-rpc-${record.nextRpcId++}`;
          record.responses.set(id, response);
          const transport = yield* process
            .send({ ...command, id })
            .pipe(Effect.forkIn(ownerScope, { startImmediately: true }));
          return { id, transport };
        }),
      );
      const outcome = yield* Effect.acquireUseRelease(
        acquireRegistration,
        (registration) => {
          const sendAndAwait = Fiber.join(registration.transport).pipe(
            Effect.mapError((error) => mapTransportUncertainty(command, error)),
            Effect.onInterrupt(() => Fiber.interrupt(registration.transport).pipe(Effect.asVoid)),
            Effect.andThen(Deferred.await(response)),
          );
          return Effect.raceFirst(sendAndAwait, Deferred.await(response)).pipe(
            Effect.timeoutOption(RPC_TIMEOUT),
          );
        },
        (registration) =>
          withLock(
            Effect.sync(() => {
              record.responses.delete(registration.id);
            }),
          ).pipe(Effect.andThen(Fiber.interrupt(registration.transport)), Effect.asVoid),
      );
      if (Option.isNone(outcome))
        return yield* new SubagentProcessError({
          operation: "await RPC response from",
          code: rpcOutcomeCode(command.type),
          message: `Subagent ${record.view.id} did not answer ${command.type}; the command may already have applied. Inspect subagent status before retrying.`,
        });
      if (!outcome.value.success)
        return yield* new SubagentProcessError({
          operation: `execute ${command.type} in`,
          message: sanitizeDiagnosticText(
            outcome.value.error ?? `Subagent RPC command ${command.type} failed.`,
            MAX_ERROR_CHARS,
          ),
        });
      return outcome.value;
    });

  const sendPeerNotices = (changedId: string) => {
    const recipients = [...records.values()].flatMap((record) => {
      const process = record.process;
      return process &&
        isActiveRunState(record.view.state) &&
        hasSubagentCapability(record.view, "peer-notice")
        ? [{ record, process }]
        : [];
    });
    return Effect.forEach(
      recipients,
      ({ record, process }) => {
        const message: PeerNotice = {
          channel: "pi-subagents",
          type: "peer_notice",
          message: peerNoticeText(records.values(), record.view.id),
        };
        return process.sendIpc(message).pipe(
          Effect.timeoutOption("1 second"),
          Effect.catch(() => Effect.void),
          Effect.asVoid,
        );
      },
      { concurrency: 8, discard: true },
    ).pipe(Effect.annotateLogs("changedRunId", changedId), Effect.asVoid);
  };

  const installProcess = (record: RunRecord) => {
    const scope = record.scope;
    return Effect.gen(function* () {
      const process = yield* childProcesses
        .spawn(record.launch)
        .pipe(Effect.provideService(Scope.Scope, scope));
      const attached = yield* withLock(
        Effect.sync(() => {
          if (
            record.scope !== scope ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped"
          )
            return false;
          record.process = process;
          record.view = { ...record.view, pid: process.pid };
          publish();
          return true;
        }),
      );
      if (!attached)
        return yield* new InvalidSubagentRequestError({
          code: "start_cancelled",
          message: `Subagent ${record.view.id} was stopped during startup.`,
        });
      const isCurrentProcess = withLock(
        Effect.sync(() => record.scope === scope && record.process === process),
      );
      const eventConsumer = yield* Stream.fromQueue(process.events).pipe(
        Stream.runForEach((event) =>
          isCurrentProcess.pipe(
            Effect.flatMap((isCurrent) =>
              isCurrent
                ? handleWireEvent(record, event).pipe(
                    Effect.catch((error) =>
                      failRun(record, error.message, error).pipe(Effect.asVoid),
                    ),
                  )
                : Effect.void,
            ),
            Effect.ensuring(Effect.sync(() => process.acknowledge?.(event))),
          ),
        ),
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      yield* process.awaitExit.pipe(
        Effect.flatMap((event) =>
          isCurrentProcess.pipe(
            Effect.flatMap((isCurrent) =>
              isCurrent
                ? markCleanupPending(record).pipe(
                    Effect.andThen(
                      Fiber.join(eventConsumer).pipe(
                        Effect.andThen(handleWireEvent(record, event)),
                      ),
                    ),
                  )
                : Effect.void,
            ),
            Effect.ensuring(
              closeExitedScope(record, scope).pipe(
                Effect.forkIn(ownerScope, { startImmediately: true }),
                Effect.asVoid,
              ),
            ),
          ),
        ),
        Effect.catch((error) => failRun(record, error.message).pipe(Effect.asVoid)),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      return process;
    });
  };

  const initializeProcess = (record: RunRecord): Effect.Effect<RpcStateData, SubagentError> =>
    Effect.gen(function* () {
      yield* installProcess(record);
      const stateResponse = yield* rpc(record, { type: "get_state" });
      return yield* decodeRpcStateData(stateResponse.data).pipe(
        Effect.mapError(() => protocolError("Subagent returned invalid startup state.")),
      );
    });

  return { rpc, sendPeerNotices, initializeProcess };
}
