import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { NONCE_BYTES, PROOF_BYTES } from "./handshake.ts";

/** Longest message text a session accepts, in UTF-16 code units. */
export const MAX_MESSAGE_CHARS = 16_384;
/** Longest assistant text `ReadLast` returns, in UTF-8 bytes. */
export const MAX_READ_BYTES = 32 * 1024;
/**
 * Bounds every NDJSON frame in either direction. It covers the largest message or read text even
 * when JSON escaping inflates each character to six bytes; anything longer closes the peer.
 */
export const MAX_FRAME_BYTES = 256 * 1024;

export const MAX_IDENTITY_CHARS = 1_024;
export const MAX_CWD_CHARS = 4_096;
const MAX_MESSAGE_ID_CHARS = 128;

const boundedString = (min: number, max: number) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));

const hex = (bytes: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[0-9a-f]{${bytes * 2}}$`)));
const NonceSchema = hex(NONCE_BYTES);
const ProofSchema = hex(PROOF_BYTES);

export const SessionStateSchema = Schema.Literals(["idle", "busy"]);
export type SessionState = typeof SessionStateSchema.Type;

/** A sending session as it describes itself; same-user identity, so advisory only. */
export const SenderSchema = Schema.Struct({
  sessionId: boundedString(1, MAX_IDENTITY_CHARS),
  name: Schema.optionalKey(boundedString(0, MAX_IDENTITY_CHARS)),
  cwd: boundedString(0, MAX_CWD_CHARS),
});
export type Sender = typeof SenderSchema.Type;

export const DescriptionSchema = Schema.Struct({
  sessionId: boundedString(1, MAX_IDENTITY_CHARS),
  name: Schema.optionalKey(boundedString(0, MAX_IDENTITY_CHARS)),
  cwd: boundedString(0, MAX_CWD_CHARS),
  state: SessionStateSchema,
});
export type Description = typeof DescriptionSchema.Type;

export const InboundMessageSchema = Schema.Struct({
  from: SenderSchema,
  messageId: boundedString(1, MAX_MESSAGE_ID_CHARS),
  text: boundedString(1, MAX_MESSAGE_CHARS),
});
export type InboundMessage = typeof InboundMessageSchema.Type;

/** How the recipient took a delivered message: started a turn, appended it, or is holding it. */
export const DispositionSchema = Schema.Literals(["woken", "queued", "held"]);
export type Disposition = typeof DispositionSchema.Type;

export const LastMessageSchema = Schema.Struct({
  /** Absent when the session has no assistant message yet. */
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_READ_BYTES))),
  truncated: Schema.Boolean,
  state: SessionStateSchema,
});
export type LastMessage = typeof LastMessageSchema.Type;

/** The proof didn't match: the caller read another runtime's record, or none. */
export class IntercomUnauthorized extends Schema.TaggedError<IntercomUnauthorized>()(
  "IntercomUnauthorized",
  {},
) {}

/**
 * `session_unavailable`: the runtime is retired or Pi didn't take the message;
 * `session_receive_disabled`: the user turned receiving off.
 */
export const RefusalCodeSchema = Schema.Literals([
  "session_unavailable",
  "session_receive_disabled",
]);
export type RefusalCode = typeof RefusalCodeSchema.Type;

/** The recipient declined the request; the code says why. */
export class IntercomRefused extends Schema.TaggedError<IntercomRefused>()("IntercomRefused", {
  code: RefusalCodeSchema,
}) {}

const RpcError = Schema.Union([IntercomUnauthorized, IntercomRefused]);

/**
 * Opens the handshake with the client's challenge. The server answers with its own challenge and
 * its proof over both, so the client learns the listener holds the record's token before it sends
 * anything else.
 */
export const HelloRpc = Rpc.make("Hello", {
  payload: { nonce: NonceSchema },
  success: Schema.Struct({ nonce: NonceSchema, proof: ProofSchema }),
});

/** Completes the handshake with the client's proof over both challenges. */
export const AuthenticateRpc = Rpc.make("Authenticate", {
  payload: { proof: ProofSchema },
  error: IntercomUnauthorized,
});

export const DescribeRpc = Rpc.make("Describe", {
  success: DescriptionSchema,
  error: RpcError,
});

export const DeliverRpc = Rpc.make("Deliver", {
  payload: InboundMessageSchema,
  success: Schema.Struct({ disposition: DispositionSchema }),
  error: RpcError,
});

export const ReadLastRpc = Rpc.make("ReadLast", {
  success: LastMessageSchema,
  error: RpcError,
});

/** The requests a connection may make before and after it authenticates. */
export const HANDSHAKE_REQUESTS = { hello: HelloRpc._tag, authenticate: AuthenticateRpc._tag };

export const IntercomRpcGroup = RpcGroup.make(
  HelloRpc,
  AuthenticateRpc,
  DescribeRpc,
  DeliverRpc,
  ReadLastRpc,
);
