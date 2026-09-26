// The one Effect RPC client of the private supervisor channel, shared by the native MCP helper and
// the in-process delegated-Pi bridge.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import {
  MAX_SUPERVISOR_CHANNEL_LINE_BYTES,
  type SupervisorChannelConfig,
  type SupervisorRpcFailure,
  SupervisorRpcGroup,
} from "../supervisor/protocol.ts";
import { SupervisorToolFailure, type SupervisorToolClient } from "../supervisor/tool-call.ts";

const CONNECT_TIMEOUT_MILLIS = 5_000;

/**
 * Opens one authenticated connection in a child of the caller's Scope. A failed or interrupted
 * open closes that child at once while the parent stays open. The assignment watch runs in the
 * parent scope; once it ends for any reason, `closed` completes and a separate parent-scoped fiber
 * closes the connection, which also stops the protocol's reconnect policy from redialing. Root
 * notifications (delegated-Pi channels only) are acknowledged after `onNotification` returns;
 * without a handler they stay unacknowledged.
 */
export const openSupervisorClient = (
  config: SupervisorChannelConfig,
  onNotification?: (message: string) => Effect.Effect<void>,
): Effect.Effect<
  SupervisorToolClient,
  RpcClientError.RpcClientError | SupervisorRpcFailure | Cause.TimeoutError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const parent = yield* Effect.scope;
    const auth = { version: config.version, runId: config.runId, token: config.token };
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const connection = yield* Scope.fork(parent);
        const { rpc, opened } = yield* restore(
          Effect.gen(function* () {
            const socket = yield* NodeSocket.makeNet({
              host: config.host,
              port: config.port,
              openTimeout: CONNECT_TIMEOUT_MILLIS,
            });
            const protocol = yield* RpcClient.makeProtocolSocket().pipe(
              Effect.provideService(
                RpcSerialization.RpcSerialization,
                RpcSerialization.makeNdjson({ maxBufferSize: MAX_SUPERVISOR_CHANNEL_LINE_BYTES }),
              ),
              Effect.provideService(Socket.Socket, socket),
            );
            const rpc = yield* RpcClient.make(SupervisorRpcGroup).pipe(
              Effect.provideService(RpcClient.Protocol, protocol),
            );
            const opened = yield* rpc
              .SupervisorOpenSession(auth)
              .pipe(Effect.timeout(CONNECT_TIMEOUT_MILLIS));
            return { rpc, opened } as const;
          }).pipe(Scope.provide(connection)),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(connection, exit) : Effect.void,
          ),
        );
        let assignmentEpoch = opened.assignmentEpoch;
        const closed = Deferred.makeUnsafe<void>();
        yield* rpc.SupervisorWatchAssignments(auth).pipe(
          Stream.runForEach((update) =>
            Effect.gen(function* () {
              if (update.kind === "notification") {
                if (!onNotification) return;
                yield* onNotification(update.message);
                return yield* rpc.SupervisorAcknowledgeNotification({
                  ...auth,
                  updateId: update.updateId,
                });
              }
              if (update.assignmentEpoch <= assignmentEpoch)
                return yield* new SupervisorToolFailure({
                  code: "non_monotonic_assignment_epoch",
                  message: "Supervisor assignment epoch did not advance.",
                });
              assignmentEpoch = update.assignmentEpoch;
              yield* rpc.SupervisorAcknowledgeAssignment({
                ...auth,
                assignmentEpoch,
                updateId: update.updateId,
              });
            }),
          ),
          Effect.ensuring(Deferred.succeed(closed, undefined)),
          Effect.forkIn(parent, { startImmediately: true }),
        );
        // An interrupted close would skip the remaining connection finalizers.
        yield* Deferred.await(closed).pipe(
          Effect.andThen(Effect.uninterruptible(Scope.close(connection, Exit.void))),
          Effect.forkIn(parent, { startImmediately: true }),
        );
        return {
          rpc,
          auth,
          assignmentEpoch: () => assignmentEpoch,
          closed,
        } satisfies SupervisorToolClient;
      }),
    );
  });
