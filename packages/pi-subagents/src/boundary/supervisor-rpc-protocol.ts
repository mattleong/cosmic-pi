// Bounded Node socket transport adapter for Effect RPC's server Protocol.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket, SocketServer } from "effect/unstable/socket";

const MAX_ACTIVE_REQUESTS = 32;
const MAX_PENDING_WRITES = 32;
const MAX_REQUEST_ID_CHARS = 128;

export interface SupervisorRpcConnectionContract {
  readonly authenticated: Deferred.Deferred<void>;
  readonly close: () => void;
  readonly clientId: number;
  accepted: boolean;
}

export class SupervisorRpcConnection extends Context.Service<
  SupervisorRpcConnection,
  SupervisorRpcConnectionContract
>()("pi-subagents/boundary/supervisor-rpc-protocol/SupervisorRpcConnection") {}

class SupervisorRpcTransportError extends Schema.TaggedError<SupervisorRpcTransportError>()(
  "SupervisorRpcTransportError",
  { reason: Schema.String },
) {}

export interface SupervisorRpcServerProtocolOptions {
  readonly server: SocketServer.SocketServer["Service"];
  readonly authTimeoutMillis: number;
  readonly maxConnections: number;
  readonly openSessionTag: string;
  readonly onDisconnect: (clientId: number) => void;
}

interface ClientTransport {
  readonly activeRequests: Set<string | number>;
  readonly output: Queue.Queue<Uint8Array | string | Socket.CloseEvent, Cause.Done>;
  readonly encode: (response: RpcMessage.FromServerEncoded) => Uint8Array | string | undefined;
  readonly close: () => void;
}

const validRequestId = (id: string | number): boolean =>
  Predicate.isNumber(id)
    ? Number.isSafeInteger(id)
    : id.length > 0 && id.length <= MAX_REQUEST_ID_CHARS;

const responseRequestId = (response: RpcMessage.FromServerEncoded): string | number | undefined =>
  "requestId" in response &&
  (Predicate.isString(response.requestId) || Predicate.isNumber(response.requestId))
    ? response.requestId
    : undefined;

export const makeSupervisorRpcServerProtocol = (
  options: SupervisorRpcServerProtocolOptions,
): Effect.Effect<
  RpcServer.Protocol["Service"],
  never,
  RpcSerialization.RpcSerialization | Scope.Scope
> =>
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    const disconnects = yield* Queue.bounded<number>(options.maxConnections);
    const clients = new Map<number, ClientTransport>();
    const clientIds = new Set<number>();
    let nextClientId = 0;
    let writeRequest: (
      clientId: number,
      message: RpcMessage.FromClientEncoded,
    ) => Effect.Effect<void> = () => Effect.void;

    const protocol = yield* RpcServer.Protocol.make((write) => {
      writeRequest = write;
      return Effect.succeed({
        disconnects,
        send: (clientId, response) =>
          Effect.suspend(() => {
            const client = clients.get(clientId);
            if (!client) return Effect.void;
            return Effect.try({
              try: () => client.encode(response),
              catch: () => new SupervisorRpcTransportError({ reason: "encode_failed" }),
            }).pipe(
              Effect.flatMap((encoded) => {
                if (encoded === undefined) return Effect.void;
                if (!Queue.offerUnsafe(client.output, encoded)) {
                  client.close();
                  return Effect.void;
                }
                if (RpcMessage.isTerminalResponse(response)) {
                  const requestId = responseRequestId(response);
                  if (requestId !== undefined) client.activeRequests.delete(requestId);
                }
                return Effect.void;
              }),
              Effect.catch(() =>
                Effect.sync(() => {
                  client.close();
                }),
              ),
            );
          }),
        end: (clientId) =>
          Effect.sync(() => {
            clients.get(clientId)?.close();
          }),
        clientIds: Effect.sync(() => clientIds),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
      });
    });

    const runConnection = (socket: Socket.Socket) =>
      Effect.scoped(
        Effect.gen(function* () {
          const netSocketOption = yield* Effect.serviceOption(NodeSocket.NetSocket);
          if (Option.isNone(netSocketOption)) return yield* Effect.never;
          const netSocket = netSocketOption.value;
          if (
            clients.size >= options.maxConnections ||
            (netSocket.remoteAddress !== "127.0.0.1" &&
              netSocket.remoteAddress !== "::ffff:127.0.0.1")
          ) {
            netSocket.destroy();
            return;
          }
          const clientId = nextClientId;
          nextClientId += 1;
          const output = yield* Queue.bounded<Uint8Array | string | Socket.CloseEvent, Cause.Done>(
            MAX_PENDING_WRITES,
          );
          const activeRequests = new Set<string | number>();
          const guard: SupervisorRpcConnectionContract = {
            authenticated: Deferred.makeUnsafe<void>(),
            close: () => netSocket.destroy(),
            clientId,
            accepted: false,
          };
          const parser = serialization.makeUnsafe();
          const client: ClientTransport = {
            activeRequests,
            output,
            encode: (response) => parser.encode(response),
            close: guard.close,
          };
          clients.set(clientId, client);
          clientIds.add(clientId);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              clients.delete(clientId);
              clientIds.delete(clientId);
              Queue.endUnsafe(output);
              options.onDisconnect(clientId);
            }).pipe(Effect.andThen(Queue.offer(disconnects, clientId)), Effect.asVoid),
          );

          const writeRaw = yield* socket.writer;
          yield* Stream.fromQueue(output).pipe(
            Stream.runForEach(writeRaw),
            Effect.catchCause(() =>
              Effect.sync(() => {
                guard.close();
              }),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(guard.authenticated).pipe(
            Effect.timeoutOption(options.authTimeoutMillis),
            Effect.flatMap((outcome) =>
              Option.isSome(outcome)
                ? Effect.never
                : Effect.sync(() => {
                    guard.close();
                  }),
            ),
            Effect.forkScoped,
          );

          yield* socket
            .runRaw((data) => {
              const decoded = Result.try({
                // SAFETY: The Effect RPC serialization service owns decoding into its declared client envelope.
                try: () => parser.decode(data) as ReadonlyArray<RpcMessage.FromClientEncoded>,
                catch: () => new SupervisorRpcTransportError({ reason: "decode_failed" }),
              });
              if (Result.isFailure(decoded)) {
                guard.close();
                return Effect.void;
              }
              return Effect.forEach(
                decoded.success,
                (message) => {
                  if (message._tag === "Request") {
                    if (
                      message.isNotification === true ||
                      !validRequestId(message.id) ||
                      activeRequests.has(message.id) ||
                      activeRequests.size >= MAX_ACTIVE_REQUESTS ||
                      (!guard.accepted && message.tag !== options.openSessionTag)
                    ) {
                      guard.close();
                      return Effect.void;
                    }
                    activeRequests.add(message.id);
                  } else if (message._tag === "Ping") {
                    if (!guard.accepted) {
                      guard.close();
                      return Effect.void;
                    }
                  } else if (message._tag !== "Eof" && !validRequestId(message.requestId)) {
                    guard.close();
                    return Effect.void;
                  }
                  return writeRequest(clientId, message).pipe(
                    Effect.provideService(SupervisorRpcConnection, guard),
                  );
                },
                { discard: true },
              );
            })
            .pipe(Effect.catchTag("SocketError", () => Effect.void));
        }),
      );

    yield* options.server.run(runConnection).pipe(Effect.forkScoped);
    return protocol;
  });
