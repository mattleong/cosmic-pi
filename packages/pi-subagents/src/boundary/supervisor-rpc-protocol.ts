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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import * as Socket from "effect/socket/Socket";
import * as SocketServer from "effect/socket/SocketServer";
import { SupervisorOpenSessionRpc } from "../supervisor/protocol.ts";

const MAX_CONNECTIONS = 4;
const MAX_ACTIVE_REQUESTS = 32;
const MAX_PENDING_WRITES = 32;
const MAX_REQUEST_ID_CHARS = 128;

export interface SupervisorRpcConnectionContract {
  readonly authenticated: Deferred.Deferred<void>;
  readonly close: () => void;
  readonly clientId: number;
  accepted: boolean;
  closed: boolean;
}

export class SupervisorRpcConnection extends Context.Service<
  SupervisorRpcConnection,
  SupervisorRpcConnectionContract
>()("pi-subagents/boundary/supervisor-rpc-protocol/SupervisorRpcConnection") {}

export interface SupervisorRpcServerProtocolOptions {
  readonly server: SocketServer.SocketServer["Service"];
  readonly authTimeoutMillis: number;
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
    // Unbounded like Effect's own protocols: connection finalizers must never wait on a consumer.
    const disconnects = yield* Queue.unbounded<number>();
    const clients = new Map<number, ClientTransport>();
    let nextClientId = 0;
    let writeRequest: (
      clientId: number,
      message: RpcMessage.FromClientEncoded,
    ) => Effect.Effect<void> = () => Effect.void;

    const protocol = yield* RpcServer.Protocol.make((write) => {
      writeRequest = write;
      return Effect.succeed({
        disconnects,
        // An unencodable response or a full output queue closes that peer.
        send: (clientId, response) =>
          Effect.sync(() => {
            const client = clients.get(clientId);
            if (!client) return;
            try {
              const encoded = client.encode(response);
              if (encoded === undefined) return;
              if (!Queue.offerUnsafe(client.output, encoded)) return client.close();
              if (RpcMessage.isTerminalResponse(response)) {
                const requestId = responseRequestId(response);
                if (requestId !== undefined) client.activeRequests.delete(requestId);
              }
            } catch {
              client.close();
            }
          }),
        end: (clientId) =>
          Effect.sync(() => {
            clients.get(clientId)?.close();
          }),
        clientIds: Effect.sync(() => new Set(clients.keys())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: true,
        supportsNotifications: true,
        codecFor: serialization.codecFor,
      });
    });

    const runConnection = (socket: Socket.Socket) =>
      Effect.scoped(
        Effect.gen(function* () {
          const netSocketOption = yield* Effect.serviceOption(NodeSocket.NetSocket);
          if (Option.isNone(netSocketOption)) return yield* Effect.never;
          const netSocket = netSocketOption.value;
          if (
            clients.size >= MAX_CONNECTIONS ||
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
            close: () => {
              guard.closed = true;
              netSocket.destroy();
            },
            clientId,
            accepted: false,
            closed: false,
          };
          const parser = serialization.makeUnsafe();
          const client: ClientTransport = {
            activeRequests,
            output,
            encode: (response) => parser.encode(response),
            close: guard.close,
          };
          clients.set(clientId, client);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              guard.closed = true;
              clients.delete(clientId);
              Queue.endUnsafe(output);
              options.onDisconnect(clientId);
              Queue.offerUnsafe(disconnects, clientId);
            }),
          );

          const writeRaw = yield* socket.writer;
          yield* Stream.fromQueue(output).pipe(
            Stream.runForEach(writeRaw.write),
            Effect.catchCause(() => Effect.sync(guard.close)),
            Effect.forkScoped,
          );
          yield* Deferred.await(guard.authenticated).pipe(
            Effect.timeoutOrElse({
              duration: options.authTimeoutMillis,
              orElse: () => Effect.sync(guard.close),
            }),
            Effect.forkScoped,
          );

          yield* Stream.fromPull(socket.reader.pipe(Effect.map((reader) => reader.pull))).pipe(
            Stream.runForEach((data) => {
              const decoded = Result.try(
                // SAFETY: The Effect RPC serialization service owns decoding into its declared client envelope.
                () => parser.decode(data) as ReadonlyArray<RpcMessage.FromClientEncoded>,
              );
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
                      (!guard.accepted && message.tag !== SupervisorOpenSessionRpc._tag)
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
            }),
            Effect.catchTag("SocketError", () => Effect.void),
          );
        }),
      );

    yield* options.server.run(runConnection).pipe(Effect.forkScoped);
    return protocol;
  });
