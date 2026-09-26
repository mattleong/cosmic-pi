import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { invokeBestEffort } from "./host-session.ts";
import { decodeUnknownOrUndefined } from "./schema/decode.ts";

/** One versioned session-capability event protocol. */
export interface SessionCapabilityProtocolOptions<Version extends number> {
  readonly version: Version;
  /** Inclusive session-id bound. Omitted means unbounded; an empty id is always rejected. */
  readonly maxSessionIdChars?: number;
}

/** A decoded capability query. `respond` swallows throws and contains a returned thenable. */
export interface SessionCapabilityQuery<Version extends number> {
  readonly version: Version;
  readonly sessionId: string;
  readonly respond: <Candidate>(candidate: Candidate) => void;
}

/**
 * Provider side of a synchronous `{ version, sessionId, respond }` event-bus query. Every hostile
 * payload is decoded once; only checked fields are retained. The owning package keeps its gates,
 * its capability's exact `execute` contract, and its public protocol names.
 */
export const makeSessionCapabilityProtocol = <const Version extends number>(
  options: SessionCapabilityProtocolOptions<Version>,
) => {
  const envelope = {
    version: Schema.Literal(options.version),
    sessionId: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(options.maxSessionIdChars ?? Number.MAX_SAFE_INTEGER),
    ),
  };
  const Query = Schema.Struct({ ...envelope, respond: Schema.declare(Predicate.isFunction) });
  const Capability = Schema.Struct({ ...envelope, execute: Schema.declare(Predicate.isFunction) });

  const normalizeQuery = <Value>(value: Value): SessionCapabilityQuery<Version> | undefined => {
    const decoded = decodeUnknownOrUndefined(Query, value);
    if (decoded === undefined) return undefined;
    const respond = decoded.respond;
    return Object.freeze({
      version: decoded.version,
      sessionId: decoded.sessionId,
      respond: <Candidate>(candidate: Candidate) => invokeBestEffort(() => respond(candidate)),
    });
  };

  /** Decodes a provider's response; the caller re-wraps `execute` with its exact contract. */
  const decodeCapability = <Value>(value: Value) => decodeUnknownOrUndefined(Capability, value);

  return { normalizeQuery, decodeCapability };
};

/** Any synchronous event bus; Pi's `ExtensionAPI["events"]` fits structurally. */
interface SessionCapabilityEvents<Candidate> {
  emit(
    channel: string,
    query: {
      readonly version: number;
      readonly sessionId: string;
      readonly respond: (candidate: Candidate) => void;
    },
  ): void;
}

/**
 * Consumer side: emits one `{ version, sessionId, respond }` query and keeps the candidates that
 * `accept` returns, in response order. Responses after `emit` returns or once `limit` candidates
 * are kept are ignored unread. A throwing `emit` or `accept` marks the query `failed`; the caller
 * owns its selection policy (last wins, exactly one).
 */
export const querySessionCapability = <Candidate, Capability>(
  events: SessionCapabilityEvents<Candidate>,
  channel: string,
  query: { readonly version: number; readonly sessionId: string },
  accept: (candidate: Candidate) => Capability | undefined,
  limit = Number.POSITIVE_INFINITY,
) => {
  const candidates: Capability[] = [];
  let accepting = true;
  let failed = false;
  try {
    events.emit(channel, {
      version: query.version,
      sessionId: query.sessionId,
      respond: (candidate: Candidate) => {
        if (!accepting || candidates.length >= limit) return;
        try {
          const accepted = accept(candidate);
          if (accepted !== undefined) candidates.push(accepted);
        } catch {
          failed = true;
        }
      },
    });
  } catch {
    failed = true;
  }
  accepting = false;
  return { candidates, failed };
};
