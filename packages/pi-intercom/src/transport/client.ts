import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as Cause from "effect/Cause";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import type * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { boundedNdjsonRpcSerialization } from "pi-cosmic-core";
import { freshNonce, handshakeKey } from "./handshake.ts";
import {
  IntercomRpcGroup,
  MAX_FRAME_BYTES,
  type Description,
  type Disposition,
  type InboundMessage,
  type IntercomRefused,
  type IntercomUnauthorized,
  type LastMessage,
} from "./protocol.ts";

/**
 * Covers connecting, both handshake proofs, and the answer. A live session answers well within it
 * even while its event loop is busy with a turn; one that doesn't is listed as unresponsive.
 */
export const DESCRIBE_DEADLINE: Duration.Input = "1500 millis";
export const DELIVER_DEADLINE: Duration.Input = "3 seconds";
export const READ_DEADLINE: Duration.Input = "2 seconds";
export const DESCRIBE_CONCURRENCY = 64;

const IntercomClientFailureSchema = Schema.Literals([
  "unreachable",
  "unresponsive",
  "disconnected",
  "unauthorized",
  "timeout",
  "protocol",
]);
export type IntercomClientFailure = typeof IntercomClientFailureSchema.Type;

/**
 * The call got no usable answer: nothing listens at the socket or the connection failed before
 * the request went out (`unreachable`), the deadline passed before the request went out
 * (`unresponsive`), the listener couldn't prove it holds the record's token or refused the
 * caller's proof, or, after the request went out, the connection ended, the deadline passed, or
 * the peer broke the protocol. Only `unreachable`, `unresponsive`, and `unauthorized` prove the
 * recipient never handled the request; after any other failure a `Deliver` may still have been
 * delivered.
 */
export class IntercomClientError extends Schema.TaggedError<IntercomClientError>()(
  "IntercomClientError",
  { reason: IntercomClientFailureSchema },
) {}

/** Where a session listens and the token it proves, as its registry record states. */
export interface IntercomTarget {
  readonly socket: string;
  readonly token: string;
}

type IntercomClient = RpcClient.FromGroup<typeof IntercomRpcGroup, RpcClientError.RpcClientError>;

const failWith = (reason: IntercomClientFailure) => new IntercomClientError({ reason });

/** Failures that leave a request's outcome open once it went out. */
const UNCERTAIN = new Set<IntercomClientFailure>(["disconnected", "timeout", "protocol"]);

const clientFailure = Match.type<RpcClientError.RpcClientError["reason"]>().pipe(
  Match.withReturnType<IntercomClientFailure>(),
  Match.tag("SocketOpenError", () => "unreachable"),
  Match.tag("SocketReadError", "SocketWriteError", "SocketCloseError", () => "disconnected"),
  Match.orElse(() => "protocol"),
);

const transportFailure = (error: RpcClientError.RpcClientError | IntercomUnauthorized) =>
  failWith(
    Predicate.isTagged(error, "IntercomUnauthorized")
      ? "unauthorized"
      : clientFailure(error.reason),
  );

/**
 * Opens the handshake and requires the listener to prove it holds the record's token before
 * anything else is sent; only then does the client prove its own. The token itself never crosses
 * the socket.
 */
const authenticate = (client: IntercomClient, token: string) =>
  Effect.gen(function* () {
    const key = yield* handshakeKey(token).pipe(Effect.mapError(() => failWith("protocol")));
    const clientNonce = yield* freshNonce;
    const challenge = yield* client.Hello({ nonce: clientNonce });
    const genuine = yield* key
      .check("server", clientNonce, challenge.nonce, challenge.proof)
      .pipe(Effect.mapError(() => failWith("protocol")));
    if (!genuine) return yield* failWith("unauthorized");
    const proof = yield* key
      .prove("client", clientNonce, challenge.nonce)
      .pipe(Effect.mapError(() => failWith("protocol")));
    return yield* client.Authenticate({ proof });
  });

/**
 * Runs one request on its own connection to `target`, bounded by `deadline` from connecting to
 * the answer, once the handshake has authenticated both ends. The connection never reconnects,
 * so every request and answer travels on the authenticated connection, and it closes when the
 * request ends.
 */
const call = <A>(
  target: IntercomTarget,
  deadline: Duration.Input,
  request: (
    client: IntercomClient,
  ) => Effect.Effect<A, RpcClientError.RpcClientError | IntercomUnauthorized | IntercomRefused>,
): Effect.Effect<A, IntercomClientError | IntercomRefused> =>
  Effect.suspend(() => {
    let requested = false;
    return Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({ path: target.socket });
      const protocol = yield* RpcClient.makeProtocolSocket({
        retryPolicy: Schedule.recurs(0),
      }).pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provideService(
          RpcSerialization.RpcSerialization,
          boundedNdjsonRpcSerialization(MAX_FRAME_BYTES),
        ),
      );
      const client = yield* RpcClient.make(IntercomRpcGroup, { disableTracing: true }).pipe(
        Effect.provideService(RpcClient.Protocol, protocol),
      );
      // A recipient that shuts down mid-request answers with an interruption; this caller wasn't.
      return yield* authenticate(client, target.token).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            requested = true;
            return request(client);
          }),
        ),
        Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Effect.fail(failWith("disconnected"))),
      );
    }).pipe(
      Effect.scoped,
      Effect.catchTags({
        RpcClientError: (error) => Effect.fail(transportFailure(error)),
        IntercomUnauthorized: (error) => Effect.fail(transportFailure(error)),
      }),
      // A peer that answers with frames the client can't decode surfaces as a defect.
      Effect.catchDefect(() => Effect.fail(failWith("protocol"))),
      Effect.timeoutOrElse({ duration: deadline, orElse: () => Effect.fail(failWith("timeout")) }),
      // Until the request goes out, the recipient has handled nothing; a listener that held the
      // connection past the deadline is still told apart from one that failed it.
      Effect.mapError((error) =>
        !requested &&
        Predicate.isTagged(error, "IntercomClientError") &&
        UNCERTAIN.has(error.reason)
          ? failWith(error.reason === "timeout" ? "unresponsive" : "unreachable")
          : error,
      ),
    );
  });

export const describeSession = (
  target: IntercomTarget,
  deadline: Duration.Input = DESCRIBE_DEADLINE,
): Effect.Effect<Description, IntercomClientError | IntercomRefused> =>
  call(target, deadline, (client) => client.Describe());

export const deliverMessage = (
  target: IntercomTarget,
  message: InboundMessage,
  deadline: Duration.Input = DELIVER_DEADLINE,
): Effect.Effect<Disposition, IntercomClientError | IntercomRefused> =>
  call(target, deadline, (client) =>
    client.Deliver(message).pipe(Effect.map(({ disposition }) => disposition)),
  );

export const readLastMessage = (
  target: IntercomTarget,
  deadline: Duration.Input = READ_DEADLINE,
): Effect.Effect<LastMessage, IntercomClientError | IntercomRefused> =>
  call(target, deadline, (client) => client.ReadLast());

/** Describes every target, at most `DESCRIBE_CONCURRENCY` at once, keeping input order. */
export const describeSessions = <Target extends IntercomTarget>(
  targets: ReadonlyArray<Target>,
  deadline: Duration.Input = DESCRIBE_DEADLINE,
): Effect.Effect<
  ReadonlyArray<{
    readonly target: Target;
    readonly result: Result.Result<Description, IntercomClientError | IntercomRefused>;
  }>
> =>
  Effect.forEach(
    targets,
    (target) =>
      describeSession(target, deadline).pipe(
        Effect.result,
        Effect.map((result) => ({ target, result })),
      ),
    { concurrency: DESCRIBE_CONCURRENCY },
  );
