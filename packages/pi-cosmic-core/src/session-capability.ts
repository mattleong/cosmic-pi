import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { invokeBestEffort } from "./host-session.ts";
import { decodeUnknownOrUndefined } from "./schema/decode.ts";

interface SessionCapabilityProtocolOptions<Version extends number> {
  readonly version: Version;
  readonly maxSessionIdChars?: number;
}

interface SessionCapabilityQuery<Version extends number> {
  readonly version: Version;
  readonly sessionId: string;
  readonly respond: <Candidate>(candidate: Candidate) => void;
}

export const makeSessionCapabilityProtocol = <const Version extends number>(
  options: SessionCapabilityProtocolOptions<Version>,
) => {
  const Query = Schema.Struct({
    version: Schema.Literal(options.version),
    sessionId: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(options.maxSessionIdChars ?? Number.MAX_SAFE_INTEGER),
    ),
    respond: Schema.declare(Predicate.isFunction),
  });

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

  return { normalizeQuery };
};

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
