import type { EventBus } from "@earendil-works/pi-coding-agent";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import { invokeBestEffort } from "./host-session.ts";
import { decodeUnknownOrUndefined } from "./schema/decode.ts";
import { ForeignCallable } from "./schema/foreign-callable.ts";

interface SessionCapabilityProtocolOptions<Version extends number> {
  readonly version: Version;
  readonly maxSessionIdChars?: number;
}

type CapabilityCandidate = Parameters<EventBus["emit"]>[1];
type CapabilityResponder = (candidate: CapabilityCandidate) => void;

interface SessionCapabilityQuery<Version extends number> {
  readonly version: Version;
  readonly sessionId: string;
  readonly respond: CapabilityResponder;
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
    respond: ForeignCallable<[candidate: CapabilityCandidate]>(),
  });

  const normalizeQuery = flow(
    decodeUnknownOrUndefined(Query),
    (decoded): SessionCapabilityQuery<Version> | undefined => {
      if (decoded === undefined) return undefined;
      const respond = decoded.respond;
      const contained: CapabilityResponder = (candidate) =>
        invokeBestEffort(() => respond(candidate));
      return Object.freeze({
        version: decoded.version,
        sessionId: decoded.sessionId,
        respond: contained,
      });
    },
  );

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
