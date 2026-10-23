import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcMessage from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import type * as Socket from "effect/socket/Socket";
import type * as SocketServer from "effect/socket/SocketServer";
import * as Match from "effect/Match";
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

interface SupervisorRpcServerProtocolOptions {
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

const RequestIdEncoded = Schema.Union([Schema.String, Schema.Finite]);

const isClientMessages = Schema.is(
  Schema.Array(
    Schema.Union([
      Schema.Struct({
        _tag: Schema.tag("Request"),
        id: RequestIdEncoded,
        tag: Schema.String,
        payload: Schema.Unknown,
        headers: Schema.Array(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
        isNotification: Schema.optionalKey(Schema.Literal(true)),
        traceId: Schema.optionalKey(Schema.String),
        spanId: Schema.optionalKey(Schema.String),
        sampled: Schema.optionalKey(Schema.Boolean),
      }),
      Schema.Struct({ _tag: Schema.tag("Ack"), requestId: RequestIdEncoded }),
      Schema.Struct({ _tag: Schema.tag("Interrupt"), requestId: RequestIdEncoded }),
      Schema.Struct({ _tag: Schema.tag("Ping") }),
      Schema.Struct({ _tag: Schema.tag("Eof") }),
    ]),
  ),
);

const validRequestId = (id: string | number): boolean =>
  Predicate.isNumber(id)
    ? Number.isSafeInteger(id)
    : id.length > 0 && id.length <= MAX_REQUEST_ID_CHARS;

const responseRequestId = (response: RpcMessage.FromServerEncoded): string | number | undefined =>
  "requestId" in response &&
  (Predicate.isString(response.requestId) || Predicate.isNumber(response.requestId))
    ? response.requestId
    : undefined;

const ignoreRequest = (): Effect.Effect<void> => Effect.void;

export const supervisorRpcServerProtocol = Effect.fn("SupervisorRpcProtocol.server")(function* (
  options: SupervisorRpcServerProtocolOptions,
): Effect.fn.Return<
  RpcServer.Protocol["Service"],
  never,
  RpcSerialization.RpcSerialization | Scope.Scope
> {
  const serialization = yield* RpcSerialization.RpcSerialization;
  const disconnects = yield* Queue.unbounded<number>();
  const clients = new Map<number, ClientTransport>();
  let nextClientId = 0;
  let writeRequest: (
    clientId: number,
    message: RpcMessage.FromClientEncoded,
  ) => Effect.Effect<void> = ignoreRequest;

  const protocol = yield* RpcServer.Protocol.make((write) => {
    writeRequest = write;
    return Effect.succeed({
      disconnects,
      send: (clientId, response) =>
        Effect.suspend(() => {
          const client = clients.get(clientId);
          if (!client) return Effect.void;
          return Effect.try(() => client.encode(response)).pipe(
            Effect.flatMap((encoded) =>
              Effect.sync(() => {
                if (encoded === undefined) return;
                if (!Queue.offerUnsafe(client.output, encoded)) return client.close();
                if (RpcMessage.isTerminalResponse(response)) {
                  const requestId = responseRequestId(response);
                  if (requestId !== undefined) client.activeRequests.delete(requestId);
                }
              }),
            ),
            Effect.catch(() => Effect.sync(client.close)),
          );
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
          return undefined;
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
            const decoded = Result.try(() => parser.decode(data));
            if (Result.isFailure(decoded) || !isClientMessages(decoded.success)) {
              guard.close();
              return Effect.void;
            }
            return Effect.forEach(
              decoded.success,
              (message) => {
                const admitted = Match.value(message).pipe(
                  Match.tag("Request", (request) => {
                    if (
                      request.isNotification === true ||
                      !validRequestId(request.id) ||
                      activeRequests.has(request.id) ||
                      activeRequests.size >= MAX_ACTIVE_REQUESTS ||
                      (!guard.accepted && request.tag !== SupervisorOpenSessionRpc._tag)
                    )
                      return false;
                    activeRequests.add(request.id);
                    return true;
                  }),
                  Match.tag("Ping", () => guard.accepted),
                  Match.tag("Eof", () => true),
                  Match.orElse((reply) => validRequestId(reply.requestId)),
                );
                if (!admitted) {
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
        return undefined;
      }),
    );

  yield* options.server.run(runConnection).pipe(Effect.forkScoped);
  return protocol;
});
