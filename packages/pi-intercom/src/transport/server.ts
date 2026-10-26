import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";
import { boundedNdjsonRpcSerialization } from "pi-cosmic-core/platform/bounded-ndjson-rpc";
import { removeOwnEntry, restrictSocket } from "../registry/private-files.ts";
import {
  DEFAULT_CONNECTION_LIMITS,
  guardedRpcProtocol,
  type ConnectionLimits,
} from "./connections.ts";
import { freshNonce, handshakeKey } from "./handshake.ts";
import {
  IntercomRpcGroup,
  IntercomUnauthorized,
  MAX_FRAME_BYTES,
  type Description,
  type Disposition,
  type InboundMessage,
  type IntercomRefused,
  type LastMessage,
} from "./protocol.ts";

/** Requests one session runtime handles at once, across all connected peers. */
const MAX_ACTIVE_REQUESTS = 64;
/** How long disposal waits for requests in flight to answer and their answers to be written. */
const SHUTDOWN_DRAIN = "250 millis";

export interface IntercomInboundContract {
  readonly describe: Effect.Effect<Description, IntercomRefused>;
  readonly deliver: (message: InboundMessage) => Effect.Effect<Disposition, IntercomRefused>;
  readonly readLast: Effect.Effect<LastMessage, IntercomRefused>;
}

/** Answers authenticated requests from other sessions on behalf of this session runtime. */
export class IntercomInbound extends Context.Service<IntercomInbound, IntercomInboundContract>()(
  "pi-intercom/transport/server/IntercomInbound",
) {}

export class IntercomServerError extends Schema.TaggedError<
  IntercomServerError,
  { readonly brand: unique symbol }
>()("IntercomServerError", { operation: Schema.Literals(["authenticate", "listen"]) }) {}

export interface IntercomServerOptions {
  /** A path this runtime reserved; nothing else may be bound there. */
  readonly socket: string;
  readonly token: string;
  /** Bounds on peer connections; the defaults suit a live session. */
  readonly limits?: ConnectionLimits | undefined;
}

/**
 * Listens on the runtime's Unix socket for the scope's lifetime and serves the intercom RPCs to
 * callers that complete the handshake for the record's token. The socket is restricted to this
 * user as soon as it is bound. Closing the scope first stops admitting connections and gives
 * requests in flight a short time to answer and their answers to reach the peer, then stops the
 * server, closes the listener, and removes the socket file it bound; a path that is already bound
 * fails the listen and is left untouched.
 */
export const serveIntercom = Effect.fn("IntercomServer.serve")(function* (
  options: IntercomServerOptions,
): Effect.fn.Return<void, IntercomServerError, IntercomInbound | Scope.Scope> {
  const inbound = yield* IntercomInbound;
  const key = yield* handshakeKey(options.token).pipe(
    Effect.mapError(() => IntercomServerError.make({ operation: "authenticate" })),
  );

  let bound = false;
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() =>
      bound
        ? removeOwnEntry(options.socket).pipe(
            Effect.catch(() => Effect.logWarning("Couldn't remove the intercom socket.")),
          )
        : Effect.void,
    ),
  );
  const server = yield* NodeSocketServer.make({ path: options.socket }).pipe(
    Effect.mapError(() => IntercomServerError.make({ operation: "listen" })),
  );
  bound = true;
  yield* restrictSocket(options.socket).pipe(
    Effect.mapError(() => IntercomServerError.make({ operation: "listen" })),
  );

  const { protocol, connection, drain } = yield* guardedRpcProtocol(
    server,
    options.limits ?? DEFAULT_CONNECTION_LIMITS,
  ).pipe(
    Effect.provideService(
      RpcSerialization.RpcSerialization,
      boundedNdjsonRpcSerialization(MAX_FRAME_BYTES),
    ),
  );

  /** Runs `effect` only for a request on a connection that completed the handshake. */
  const authenticated = <A, E>(client: Rpc.ServerClient, effect: Effect.Effect<A, E>) =>
    connection(client.id)?.phase === "authenticated"
      ? effect
      : Effect.fail(IntercomUnauthorized.make());

  const handlers = yield* IntercomRpcGroup.toHandlers(
    IntercomRpcGroup.of({
      Hello: ({ nonce }, { client }) => {
        const peer = connection(client.id);
        // `Hello` declares no error, so a refused challenge closes the connection and the
        // handler ends without an answer.
        const refuse = Effect.suspend(() => {
          peer?.close();
          return Effect.interrupt;
        });
        return Effect.gen(function* () {
          if (peer?.phase !== "fresh") return yield* refuse;
          const serverNonce = yield* freshNonce;
          const proof = yield* key.prove("server", nonce, serverNonce);
          // The authentication deadline may have closed the peer while the proof was made.
          if (!peer.advance("fresh", "challenged")) return yield* refuse;
          peer.clientNonce = nonce;
          peer.serverNonce = serverNonce;
          return { nonce: serverNonce, proof };
        }).pipe(Effect.catchTag("IntercomHandshakeError", () => refuse));
      },
      Authenticate: Effect.fnUntraced(function* ({ proof }, { client }) {
        const peer = connection(client.id);
        if (peer?.phase !== "challenged") return yield* IntercomUnauthorized.make();
        const valid = yield* key
          .check("client", peer.clientNonce, peer.serverNonce, proof)
          .pipe(Effect.orElseSucceed(() => false));
        // A failed proof admits nothing more; the authentication deadline closes the peer. A
        // peer closed during the check stays refused.
        const admitted = peer.advance("challenged", valid ? "authenticated" : "refused") && valid;
        return admitted ? undefined : yield* IntercomUnauthorized.make();
      }),
      Describe: (_payload, { client }) => authenticated(client, inbound.describe),
      Deliver: (message, { client }) =>
        authenticated(
          client,
          inbound.deliver(message).pipe(Effect.map((disposition) => ({ disposition }))),
        ),
      ReadLast: (_payload, { client }) => authenticated(client, inbound.readLast),
    }),
  );
  // Tracing stays off: a peer is another session and must not parent spans in this one.
  yield* RpcServer.make(IntercomRpcGroup, {
    concurrency: MAX_ACTIVE_REQUESTS,
    disableTracing: true,
  }).pipe(
    Effect.provide(handlers),
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.forkScoped,
  );
  // Added last, so disposal drains before the server is interrupted: a refusal already decided
  // still reaches its caller, who would otherwise see only the connection end.
  yield* Effect.addFinalizer(() =>
    drain.pipe(Effect.timeoutOrElse({ duration: SHUTDOWN_DRAIN, orElse: () => Effect.void })),
  );
});
