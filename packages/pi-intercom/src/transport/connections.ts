import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
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
import { HANDSHAKE_REQUESTS } from "./protocol.ts";

/** Requests one connection may have in flight; a client makes one at a time. */
const MAX_PENDING_REQUESTS = 4;
const MAX_PENDING_WRITES = 16;
const MAX_REQUEST_ID_CHARS = 64;

export interface ConnectionLimits {
  /** Connections served at once; any beyond are closed as they arrive. */
  readonly maxConnections: number;
  /** A connection that hasn't authenticated by then is closed. */
  readonly authenticationDeadline: Duration.Input;
  /** A connection with nothing in flight and no traffic for this long is closed. */
  readonly idleDeadline: Duration.Input;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = {
  maxConnections: 32,
  authenticationDeadline: "2 seconds",
  idleDeadline: "10 seconds",
};

/**
 * `fresh`: no request yet; `challenged`: the server answered the client's challenge; `refused`:
 * the client's proof failed and nothing more is admitted; `authenticated`: both sides proved the
 * token.
 */
export type ConnectionPhase = "fresh" | "challenged" | "refused" | "authenticated";

/** One peer connection's handshake state, which the RPC handlers advance. */
export interface IntercomConnection {
  readonly phase: ConnectionPhase;
  clientNonce: string;
  serverNonce: string;
  /**
   * Moves the handshake from `from` to `to` and reports whether it did. A connection that has
   * moved on or closed since, as the authentication deadline may while a handler awaits, stays
   * where it is: a refused or ended connection never advances.
   */
  readonly advance: (from: Exclude<ConnectionPhase, "refused">, to: ConnectionPhase) => boolean;
  readonly close: () => void;
}

interface ConnectionTransport {
  readonly connection: IntercomConnection;
  readonly activeRequests: Set<string | number>;
  readonly output: Queue.Queue<Uint8Array | string, Cause.Done>;
  readonly encode: (response: RpcMessage.FromServerEncoded) => Uint8Array | string | undefined;
  lastActivity: number;
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

/**
 * Whether a connection in `phase` may make request `tag`. The handshake is strictly sequential:
 * `Hello`, then `Authenticate`, each with nothing else in flight; only an authenticated
 * connection reaches the session.
 */
const admits = (phase: ConnectionPhase, tag: string, inFlight: number): boolean =>
  Match.value(phase).pipe(
    Match.when("fresh", () => inFlight === 0 && tag === HANDSHAKE_REQUESTS.hello),
    Match.when("challenged", () => inFlight === 0 && tag === HANDSHAKE_REQUESTS.authenticate),
    Match.when("refused", () => false),
    Match.when(
      "authenticated",
      () => tag !== HANDSHAKE_REQUESTS.hello && tag !== HANDSHAKE_REQUESTS.authenticate,
    ),
    Match.exhaustive,
  );

const ignoreRequest = (): Effect.Effect<void> => Effect.void;

/** Queues an answer for the peer, closing it when the answer can't be encoded or queued. */
const queueResponse = (
  transport: ConnectionTransport,
  response: RpcMessage.FromServerEncoded,
  now: number,
): void => {
  transport.lastActivity = now;
  const encoded = Result.try(() => transport.encode(response));
  if (Result.isFailure(encoded) || encoded.success === undefined) {
    if (Result.isFailure(encoded)) transport.connection.close();
    return;
  }
  if (!Queue.offerUnsafe(transport.output, encoded.success)) {
    transport.connection.close();
    return;
  }
  if (RpcMessage.isTerminalResponse(response)) {
    const requestId = responseRequestId(response);
    if (requestId !== undefined) transport.activeRequests.delete(requestId);
  }
};

export interface GuardedProtocol {
  readonly protocol: RpcServer.Protocol["Service"];
  /** The connection a request arrived on, while it is open. */
  readonly connection: (clientId: number) => IntercomConnection | undefined;
}

/**
 * Serves RPC over the socket server's connections while bounding what each peer can hold: at
 * most `maxConnections` at once, a deadline to authenticate, an idle deadline, a few requests in
 * flight, and a bounded write backlog. Anything outside the handshake order or those bounds
 * closes the connection.
 */
export const guardedRpcProtocol = Effect.fn("IntercomConnections.guardedRpcProtocol")(function* (
  server: SocketServer.SocketServer["Service"],
  limits: ConnectionLimits,
): Effect.fn.Return<GuardedProtocol, never, RpcSerialization.RpcSerialization | Scope.Scope> {
  const serialization = yield* RpcSerialization.RpcSerialization;
  const disconnects = yield* Queue.unbounded<number>();
  const transports = new Map<number, ConnectionTransport>();
  const idleMillis = Duration.toMillis(Duration.fromInputUnsafe(limits.idleDeadline));
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
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.sync(() => {
            const transport = transports.get(clientId);
            if (transport) queueResponse(transport, response, now);
          }),
        ),
      end: (clientId) =>
        Effect.sync(() => {
          transports.get(clientId)?.connection.close();
        }),
      clientIds: Effect.sync(() => new Set(transports.keys())),
      initialMessage: Effect.succeedNone,
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: false,
      supportsNotifications: false,
      codecFor: serialization.codecFor,
    });
  });

  const runConnection = (socket: Socket.Socket) =>
    Effect.scoped(
      Effect.gen(function* () {
        const netSocket = yield* Effect.serviceOption(NodeSocket.NetSocket);
        if (Option.isNone(netSocket)) return;
        const output = yield* Queue.bounded<Uint8Array | string, Cause.Done>(MAX_PENDING_WRITES);
        const arrived = yield* Clock.currentTimeMillis;
        // From the bound check to taking the slot nothing yields, so concurrent connections can't
        // both take the last one.
        if (transports.size >= limits.maxConnections) {
          netSocket.value.destroy();
          return;
        }
        const clientId = nextClientId;
        nextClientId += 1;
        let phase: ConnectionPhase = "fresh";
        const connection: IntercomConnection = {
          get phase() {
            return phase;
          },
          clientNonce: "",
          serverNonce: "",
          advance: (from, to) => {
            if (phase !== from) return false;
            phase = to;
            return true;
          },
          close: () => {
            phase = "refused";
            netSocket.value.destroy();
          },
        };
        const parser = serialization.makeUnsafe();
        const transport: ConnectionTransport = {
          connection,
          activeRequests: new Set(),
          output,
          encode: (response) => parser.encode(response),
          lastActivity: arrived,
        };
        transports.set(clientId, transport);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            phase = "refused";
            transports.delete(clientId);
            Queue.endUnsafe(output);
            Queue.offerUnsafe(disconnects, clientId);
          }),
        );

        const writer = yield* socket.writer;
        yield* Stream.fromQueue(output).pipe(
          Stream.runForEach(writer.write),
          Effect.catchCause(() => Effect.sync(connection.close)),
          Effect.forkScoped,
        );
        yield* Effect.sleep(limits.authenticationDeadline).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (connection.phase !== "authenticated") connection.close();
            }),
          ),
          Effect.forkScoped,
        );
        yield* Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (transport.activeRequests.size === 0 && now - transport.lastActivity >= idleMillis)
            connection.close();
        }).pipe(Effect.delay(limits.idleDeadline), Effect.forever, Effect.forkScoped);

        const admit = (message: RpcMessage.FromClientEncoded): boolean =>
          Match.value(message).pipe(
            Match.tag("Request", (request) => {
              const { activeRequests } = transport;
              if (
                request.isNotification === true ||
                !validRequestId(request.id) ||
                activeRequests.has(request.id) ||
                activeRequests.size >= MAX_PENDING_REQUESTS ||
                !admits(connection.phase, request.tag, activeRequests.size)
              )
                return false;
              activeRequests.add(request.id);
              return true;
            }),
            Match.tag("Ping", () => connection.phase === "authenticated"),
            Match.tag("Eof", () => true),
            Match.orElse((reply) => validRequestId(reply.requestId)),
          );

        yield* Stream.fromPull(socket.reader.pipe(Effect.map((reader) => reader.pull))).pipe(
          Stream.runForEach((data) =>
            Effect.gen(function* () {
              transport.lastActivity = yield* Clock.currentTimeMillis;
              const decoded = Result.try(() => parser.decode(data));
              if (Result.isFailure(decoded) || !isClientMessages(decoded.success)) {
                connection.close();
                return;
              }
              for (const message of decoded.success) {
                if (!admit(message)) {
                  connection.close();
                  return;
                }
                yield* writeRequest(clientId, message);
              }
            }),
          ),
          Effect.catchTag("SocketError", () => Effect.void),
        );
      }),
    );

  yield* server.run(runConnection).pipe(Effect.forkScoped);
  return {
    protocol,
    connection: (clientId: number) => transports.get(clientId)?.connection,
  } satisfies GuardedProtocol;
});
