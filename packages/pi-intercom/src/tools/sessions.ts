import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { safeTextPrefix } from "pi-cosmic-core/text";
import { synchronousRandomHex } from "pi-cosmic-core/platform/native-crypto";
import type { SessionRecord } from "../registry/schema.ts";
import { IntercomRegistry, LIVENESS_CONCURRENCY, ownerIsDead } from "../registry/store.ts";
import { IntercomSession } from "../session/service.ts";
import {
  deliverMessage,
  describeSessions,
  readLastMessage,
  type IntercomClientError,
} from "../transport/client.ts";
import {
  MAX_CWD_CHARS,
  MAX_IDENTITY_CHARS,
  MAX_MESSAGE_CHARS,
  type Description,
  type InboundMessage,
  type IntercomRefused,
} from "../transport/protocol.ts";
import {
  contractEnvelope,
  MAX_LISTED_SESSIONS,
  SESSION_TOOL,
  SessionViewSchema,
  ToolRefusalCodeSchema,
  type ListedSession,
  type SessionListContract,
  type SessionReadContract,
  type SessionSendDetails,
  type SessionView,
  type ToolRefusalCode,
} from "./contract.ts";

const MESSAGE_ID_BYTES = 16;

/** A send or read that didn't happen; the code says why. */
export class SessionToolRefusal extends Schema.TaggedError<
  SessionToolRefusal,
  { readonly brand: unique symbol }
>()("SessionToolRefusal", {
  code: ToolRefusalCodeSchema,
  session: Schema.optionalKey(SessionViewSchema),
}) {}

const isRefusal = Schema.is(SessionToolRefusal);

const viewOf = (record: Pick<SessionRecord, "sessionId" | "name" | "cwd">): SessionView => ({
  sessionId: safeTextPrefix(record.sessionId, MAX_IDENTITY_CHARS),
  ...(record.name !== undefined && { name: safeTextPrefix(record.name, MAX_IDENTITY_CHARS) }),
  cwd: safeTextPrefix(record.cwd, MAX_CWD_CHARS),
});

/** Records of other runtimes; ones whose owners are dead are left for the next sweep. */
const peerRecords = Effect.gen(function* () {
  const registry = yield* IntercomRegistry;
  const self = yield* IntercomSession.use((session) => session.record);
  const { records } = yield* registry.list();
  return Arr.filter(records, (record) => record.instance !== self.instance);
});

/** Only a listener that proved it holds the record's token can answer or refuse. */
const answered = (result: Result.Result<unknown, IntercomClientError | IntercomRefused>) =>
  Result.isSuccess(result) || Predicate.isTagged(result.failure, "IntercomRefused");

/** Describes each record, dropping one that didn't answer when its owner is dead. */
const describeLive = Effect.fn("IntercomTools.describeLive")(function* (
  records: ReadonlyArray<SessionRecord>,
) {
  const described = yield* describeSessions(records);
  return yield* Effect.filter(
    described,
    ({ target, result }) =>
      answered(result) ? Effect.succeed(true) : Effect.map(ownerIsDead(target), (dead) => !dead),
    { concurrency: LIVENESS_CONCURRENCY },
  );
});

const clientRefusalCode = (error: IntercomClientError): ToolRefusalCode =>
  error.reason === "timeout" || error.reason === "unresponsive"
    ? "session_unresponsive"
    : "session_unreachable";

interface Described {
  readonly target: SessionRecord;
  readonly result: Result.Result<Description, IntercomClientError | IntercomRefused>;
}

/**
 * How much a failed `Describe` shows about its session: a refusal proves the token, and taking the
 * connection proves more than nothing answering.
 */
const evidenceRank = ({ result }: Described): number => {
  if (Result.isSuccess(result) || Predicate.isTagged(result.failure, "IntercomRefused")) return 0;
  return clientRefusalCode(result.failure) === "session_unresponsive" ? 1 : 2;
};

/** Most informative first, then by instance, so the outcome doesn't depend on listing order. */
const byEvidence: Order.Order<Described> = (left, right) =>
  Order.Number(evidenceRank(left), evidenceRank(right)) ||
  Fn.pipe(left.target.instance, Str.localeCompare(right.target.instance));

/** The caller couldn't reach the recipient, or the recipient refused before handling anything. */
const refusedBy = (record: SessionRecord) => (error: IntercomClientError | IntercomRefused) =>
  SessionToolRefusal.make({
    code: Predicate.isTagged(error, "IntercomRefused") ? error.code : clientRefusalCode(error),
    session: viewOf(record),
  });

/**
 * A lone match is checked by the call itself. Among duplicates, the one session that answered
 * `Describe` is addressed: answering proves it holds its record's token, while a silent record,
 * such as a suspended Pi's, can't take the call anyway. Several answering sessions are ambiguous;
 * with none, the most informative failure among owners not known to be dead names why it can't be
 * reached, whatever order the registry listed them in.
 */
const resolvePeer = Effect.fn("IntercomTools.resolvePeer")(function* (to: string) {
  const matches = Arr.filter(yield* peerRecords, (record) => record.sessionId === to);
  if (matches.length <= 1) {
    const [only] = matches;
    if (only === undefined) return yield* SessionToolRefusal.make({ code: "session_not_found" });
    return only;
  }
  const live = yield* describeLive(matches);
  const answering = Arr.filter(live, ({ result }) => Result.isSuccess(result));
  const [first] = answering;
  if (first !== undefined && answering.length > 1)
    return yield* SessionToolRefusal.make({
      code: "session_ambiguous",
      session: viewOf(first.target),
    });
  if (first !== undefined) return first.target;
  const [silent] = Arr.sort(live, byEvidence);
  if (silent === undefined) return yield* SessionToolRefusal.make({ code: "session_not_found" });
  if (Result.isFailure(silent.result))
    return yield* refusedBy(silent.target)(silent.result.failure);
  return silent.target;
});

/** A recipient that never answered isn't a session anymore when its owner is dead. */
const unanswered = Effect.fn("IntercomTools.unanswered")(function* (
  record: SessionRecord,
  error: IntercomClientError | IntercomRefused,
) {
  if (Predicate.isTagged(error, "IntercomClientError") && (yield* ownerIsDead(record)))
    return yield* SessionToolRefusal.make({ code: "session_not_found" });
  return yield* refusedBy(record)(error);
});

/** A refusal comes from the session itself, which proved it holds its token. */
const silentState = (error: IntercomClientError | IntercomRefused): ListedSession["state"] => {
  if (Predicate.isTagged(error, "IntercomRefused")) return "unavailable";
  return clientRefusalCode(error) === "session_unresponsive" ? "unresponsive" : "unreachable";
};

const byName = (left: ListedSession, right: ListedSession): number =>
  Fn.pipe(left.name ?? "", Str.localeCompare(right.name ?? "")) ||
  Fn.pipe(left.sessionId, Str.localeCompare(right.sessionId));

/**
 * Every other live session, described live; one that refuses is unavailable, one that doesn't
 * answer in time is unresponsive, and one nothing answers for is unreachable. Only sessions that answered count as duplicates, since
 * only they can be addressed.
 */
export const listSessions = Effect.fn("IntercomTools.list")(function* () {
  const described = yield* describeLive(yield* peerRecords);
  const counts = new Map<string, number>();
  for (const { target, result } of described)
    if (Result.isSuccess(result))
      counts.set(target.sessionId, (counts.get(target.sessionId) ?? 0) + 1);
  const sessions: Array<ListedSession> = [];
  for (const { target, result } of described) {
    if (Result.isFailure(result)) {
      sessions.push(
        Object.assign(viewOf(target), { state: silentState(result.failure), duplicate: false }),
      );
      continue;
    }
    const { name, cwd, state } = result.success;
    const view = viewOf({ sessionId: target.sessionId, cwd, ...(name !== undefined && { name }) });
    sessions.push(
      Object.assign(view, { state, duplicate: (counts.get(target.sessionId) ?? 0) > 1 }),
    );
  }
  sessions.sort(byName);
  return {
    ...contractEnvelope,
    tool: SESSION_TOOL.list,
    sessions: sessions.slice(0, MAX_LISTED_SESSIONS),
    omitted: Math.max(0, sessions.length - MAX_LISTED_SESSIONS),
  } satisfies SessionListContract;
});

/** How long a send or read waits before trying a session that seemed gone once more. */
export const RELOAD_RETRY_DELAY = "250 millis";

/**
 * A session reloading under its id refuses while it closes, then is briefly unregistered or not yet
 * listening, which looks like one that exited. Each of these refusals proves nothing was handled,
 * so the call resolves the id again and retries once; the wait ends with the caller's
 * interruption. A session that keeps refusing, or is gone for good, is reported after the retry.
 */
const RETRIED: ReadonlySet<ToolRefusalCode> = new Set([
  "session_not_found",
  "session_unreachable",
  "session_unavailable",
]);

const retryingWhileReloading = <A, E, R>(attempt: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  attempt.pipe(
    Effect.catchIf(
      (error) => isRefusal(error) && RETRIED.has(error.code),
      () => Effect.andThen(Effect.sleep(RELOAD_RETRY_DELAY), attempt),
    ),
  );

const deliverTo = Effect.fn("IntercomTools.deliverTo")(function* (
  to: string,
  message: InboundMessage,
) {
  const record = yield* resolvePeer(to);
  const session = viewOf(record);
  const delivered = yield* deliverMessage(record, message).pipe(Effect.result);
  if (Result.isSuccess(delivered))
    return {
      ...contractEnvelope,
      tool: SESSION_TOOL.send,
      outcome: "delivered",
      session,
      disposition: delivered.success,
    } satisfies SessionSendDetails;
  const failure = delivered.failure;
  if (
    Predicate.isTagged(failure, "IntercomClientError") &&
    (failure.reason === "timeout" ||
      failure.reason === "disconnected" ||
      failure.reason === "protocol")
  )
    return {
      ...contractEnvelope,
      tool: SESSION_TOOL.send,
      outcome: "uncertain",
      session,
      reason: failure.reason,
    } satisfies SessionSendDetails;
  // Only a request that certainly went unhandled can name an owner that was already gone.
  return yield* unanswered(record, failure);
});

/**
 * Delivers `text` to the session with id `to`, trying once more when it seemed gone. A timeout or a
 * connection lost after the request went out leaves the outcome uncertain: the recipient may have
 * taken it, so it is never retried.
 */
export const sendToSession = Effect.fn("IntercomTools.send")(function* (to: string, text: string) {
  if (text.length > MAX_MESSAGE_CHARS)
    return yield* SessionToolRefusal.make({ code: "session_message_too_long" });
  const self = yield* IntercomSession.use((session) => session.record);
  const messageId = yield* Effect.sync(() => synchronousRandomHex(MESSAGE_ID_BYTES));
  return yield* retryingWhileReloading(deliverTo(to, { from: viewOf(self), messageId, text }));
});

const readFrom = Effect.fn("IntercomTools.readFrom")(function* (to: string) {
  const record = yield* resolvePeer(to);
  const last = yield* readLastMessage(record).pipe(
    Effect.catch((error) => unanswered(record, error)),
  );
  return {
    ...contractEnvelope,
    tool: SESSION_TOOL.read,
    session: viewOf(record),
    ...last,
  } satisfies SessionReadContract;
});

/** The latest assistant text of the session with id `to`; reading never changes the session. */
export const readSession = Effect.fn("IntercomTools.read")(function* (to: string) {
  return yield* retryingWhileReloading(readFrom(to));
});
