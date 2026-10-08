/**
 * Pure UUID/result correlation bookkeeping for the local Claude adapter. The
 * driver owns interrupt lifecycles, control responses, assignment epochs, and
 * initialization; separate delivery and usage owners handle report buffering
 * and cumulative accounting. This module tracks sent inputs and the native
 * result each owns.
 */
import type { ClaudeProtocolEvent } from "./local-claude-protocol.ts";
import type { UsageComponents } from "./local-claude-usage.ts";

/** Bound shared by the confirmed-UUID window and the result-expectation FIFO. */
export const SENT_UUID_LIMIT = 64;

/** Re-inserts a key as the newest entry, evicting the oldest entries beyond `limit`. */
export const rememberBounded = <Key, Value>(
  map: Map<Key, Value>,
  key: Key,
  value: Value,
  limit: number,
): void => {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= limit) break;
    map.delete(oldest);
  }
};

export type ClaudeSentUserKind = "probe" | "assignment" | "steer";
export type ClaudeSentContentMatch = ClaudeSentUserKind | "multiple" | "other";

interface ClaudeSentUserIdentity {
  readonly contentDigest: string;
  readonly kind: ClaudeSentUserKind;
}

/** Claude-owned replay origins that own one synthetic subturn/result. */
const INTERNAL_REPLAY_ORIGINS: ReadonlySet<string> = new Set([
  "task-notification",
  "auto-continuation",
]);

/**
 * Subkinds identify externally delivered task notifications such as peer
 * messages and scheduled triggers. Only an unqualified internal origin may
 * join the active assignment.
 */
export const isInternalReplayOrigin = (
  originKind: string | undefined,
  originSubkind: string | undefined,
): boolean => originSubkind === undefined && INTERNAL_REPLAY_ORIGINS.has(originKind ?? "");

const hasTaskNotificationEnvelope = (text: string): boolean => {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<task-notification>") &&
    trimmed.indexOf("</task-notification>", "<task-notification>".length) >= 0
  );
};

/**
 * `labelled`: current Claude derives the unqualified `task-notification`
 * origin only for its own queued task-notification commands, so adapter input
 * can never carry it. `unlabelled`: Claude 2.1.259 omitted the origin.
 */
type ClaudeTaskNotificationReplay = "labelled" | "unlabelled";

/**
 * Claude replays a non-meta task notification that it drains from its command
 * queue into a running turn, or folds into a merged turn, with `isReplay`, a
 * fresh UUID, and no synthetic flag. The complete fixed envelope is protocol
 * evidence, not content identity: its UUID still cannot confirm adapter input.
 */
export const claudeTaskNotificationReplay = (
  event: Extract<ClaudeProtocolEvent, { readonly type: "user" }>,
): ClaudeTaskNotificationReplay | undefined => {
  if (
    !event.isReplay ||
    event.isSynthetic ||
    event.isMeta ||
    event.isCompactSummary ||
    event.uuid === undefined ||
    event.sessionId === undefined ||
    event.parentToolUseId !== undefined ||
    event.originSubkind !== undefined ||
    event.toolResults.length > 0 ||
    event.contentKind !== "text" ||
    !hasTaskNotificationEnvelope(event.text)
  )
    return undefined;
  if (event.originKind === undefined) return "unlabelled";
  return event.originKind === "task-notification" ? "labelled" : undefined;
};

const DIAGNOSTIC_ORIGINS: ReadonlySet<string> = new Set([
  "human",
  "plugin",
  "channel",
  "task-notification",
  "peer",
  "coordinator",
  "unclassified",
  "observer",
  "auto-continuation",
  "observer-activity",
  "slack-ping",
]);
const DIAGNOSTIC_ORIGIN_SUBKINDS: ReadonlySet<string> = new Set([
  "scheduled-trigger",
  "peer-send-message",
  "projects-relay",
]);

type ClaudeUserProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "user" }>;

export const isSameClaudeSession = (
  eventSessionId: string | undefined,
  nativeSessionId: string | undefined,
): boolean =>
  eventSessionId === undefined ||
  nativeSessionId === undefined ||
  eventSessionId === nativeSessionId;

type ClaudeSessionDiagnostic = "absent" | "uninitialized" | "match" | "mismatch";

export const claudeSessionDiagnostic = (
  eventSessionId: string | undefined,
  nativeSessionId: string | undefined,
): ClaudeSessionDiagnostic =>
  eventSessionId === undefined
    ? "absent"
    : nativeSessionId === undefined
      ? "uninitialized"
      : eventSessionId === nativeSessionId
        ? "match"
        : "mismatch";

const diagnosticOrigin = (value: string | undefined, known: ReadonlySet<string>): string =>
  value === undefined ? "absent" : known.has(value) ? value : "other";

const DIAGNOSTIC_LEADING_TAGS = [
  "task-notification",
  "system-reminder",
  "teammate-message",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
] as const;

type ClaudeTextLengthDiagnostic = "empty" | "1-64" | "65-1024" | "1025-16384" | "over-16384";

export const claudeTextLengthDiagnostic = (length: number): ClaudeTextLengthDiagnostic =>
  length === 0
    ? "empty"
    : length <= 64
      ? "1-64"
      : length <= 1_024
        ? "65-1024"
        : length <= 16_384
          ? "1025-16384"
          : "over-16384";

export type ClaudeLeadingTagDiagnostic =
  | "none"
  | "other"
  | (typeof DIAGNOSTIC_LEADING_TAGS)[number];

export const claudeLeadingTagDiagnostic = (text: string): ClaudeLeadingTagDiagnostic => {
  const tag = /^\s*<([a-z][a-z0-9-]{0,63})(?:\s|>)/u.exec(text.slice(0, 256))?.[1];
  return tag === undefined
    ? "none"
    : (DIAGNOSTIC_LEADING_TAGS.find((known) => known === tag) ?? "other");
};

type ClaudeOutboundAgeDiagnostic = "none" | "under-1s" | "1-10s" | "11-60s" | "over-60s";

export const claudeOutboundAgeDiagnostic = (
  nowMillis: number,
  lastOutboundAtMillis: number | undefined,
): ClaudeOutboundAgeDiagnostic => {
  if (lastOutboundAtMillis === undefined) return "none";
  const age = Math.max(0, nowMillis - lastOutboundAtMillis);
  return age < 1_000 ? "under-1s" : age <= 10_000 ? "1-10s" : age <= 60_000 ? "11-60s" : "over-60s";
};

export interface ClaudeUserDiagnosticContext {
  readonly sequence: number;
  readonly contentMatch: ClaudeSentContentMatch;
  readonly pending: "initialize" | "start" | "steer" | "interrupt" | "none";
  readonly report: "accepted" | "none" | "unknown";
  readonly sinceOutbound: ClaudeOutboundAgeDiagnostic;
  readonly traceEnabled: boolean;
}

/** Fixed-field diagnostics that never retain message text or correlation IDs. */
export const uncorrelatedClaudeUserMessage = (
  event: ClaudeUserProtocolEvent,
  nativeSessionId: string | undefined,
  context: ClaudeUserDiagnosticContext,
): string =>
  [
    "Claude replayed an uncorrelated stream-input message.",
    `[sequence=${Math.max(0, Math.trunc(context.sequence))}`,
    `uuid=${event.uuid === undefined ? "absent" : "present"}`,
    `session=${claudeSessionDiagnostic(event.sessionId, nativeSessionId)}`,
    `replay=${event.isReplay}`,
    `synthetic=${event.isSynthetic}`,
    `meta=${event.isMeta}`,
    `compact=${event.isCompactSummary}`,
    `origin=${diagnosticOrigin(event.originKind, DIAGNOSTIC_ORIGINS)}`,
    `subkind=${diagnosticOrigin(event.originSubkind, DIAGNOSTIC_ORIGIN_SUBKINDS)}`,
    `parent-tool=${event.parentToolUseId === undefined ? "absent" : "present"}`,
    `tool-results=${event.toolResults.length === 0 ? "none" : "present"}`,
    `content=${context.contentMatch}`,
    `shape=${event.contentKind}`,
    `length=${claudeTextLengthDiagnostic(event.textLength)}`,
    `tag=${claudeLeadingTagDiagnostic(event.text)}`,
    `since-outbound=${context.sinceOutbound}`,
    `pending=${context.pending}`,
    `report=${context.report}`,
    `trace=${context.traceEnabled ? "enabled" : "disabled"}]`,
  ].join("; ");

/** Correlates a native result to the exact user input that started its query. */
export interface ResultExpectation {
  readonly uuid: string;
  readonly kind: "initialization" | "assignment" | "synthetic";
  readonly epoch: number;
  /** Global emitted-usage watermark when this exact native query was registered. */
  readonly usageBaseline: UsageComponents;
}

export const makeClaudeResultCorrelation = () => {
  const sentUserUuids = new Map<string, ClaudeSentUserIdentity | undefined>();
  const internalReplayUuids = new Map<string, true>();
  const resultExpectations = new Map<string, ResultExpectation>();
  /** FIFO used only when the current protocol legitimately omits user_message_uuid. */
  const resultOrder: ResultExpectation[] = [];

  const matchSentContent = (contentDigest: string): ClaudeSentContentMatch => {
    const kinds = new Set<ClaudeSentUserKind>();
    for (const identity of sentUserUuids.values())
      if (identity?.contentDigest === contentDigest) kinds.add(identity.kind);
    if (kinds.size === 0) return "other";
    if (kinds.size > 1) return "multiple";
    return kinds.values().next().value ?? "other";
  };

  const register = (
    expectation: Omit<ResultExpectation, "usageBaseline">,
    usageBaseline: UsageComponents,
  ): void => {
    const owned = { ...expectation, usageBaseline: { ...usageBaseline } };
    resultExpectations.set(owned.uuid, owned);
    resultOrder.push(owned);
    while (resultOrder.length > SENT_UUID_LIMIT) {
      // A replayed notification that Claude drained into a running turn owns no
      // result, so synthetic expectations go first and never evict adapter input.
      const synthetic = resultOrder.findIndex((candidate) => candidate.kind === "synthetic");
      const [evicted] = resultOrder.splice(Math.max(0, synthetic), 1);
      if (evicted) resultExpectations.delete(evicted.uuid);
    }
  };

  /**
   * Takes the expectation for a native result: the exact `user_message_uuid`
   * when reported; otherwise the oldest synthetic expectation for a
   * Claude-owned internal replay origin, or the issue-order FIFO head for a
   * pinned protocol frame that legitimately omits the UUID.
   */
  const take = (
    userMessageUuid: string | undefined,
    originKind: string | undefined,
    originSubkind: string | undefined,
  ): ResultExpectation | undefined => {
    if (userMessageUuid !== undefined) {
      const expectation = resultExpectations.get(userMessageUuid);
      if (!expectation) return undefined;
      resultExpectations.delete(userMessageUuid);
      const index = resultOrder.indexOf(expectation);
      if (index >= 0) resultOrder.splice(index, 1);
      return expectation;
    }
    const index = isInternalReplayOrigin(originKind, originSubkind)
      ? resultOrder.findIndex((candidate) => candidate.kind === "synthetic")
      : resultOrder.findIndex((candidate) => candidate.kind !== "synthetic");
    if (index < 0) return undefined;
    const [expectation] = resultOrder.splice(index, 1);
    if (expectation) resultExpectations.delete(expectation.uuid);
    return expectation;
  };

  const clear = (): void => {
    sentUserUuids.clear();
    internalReplayUuids.clear();
    resultExpectations.clear();
    resultOrder.length = 0;
  };

  return {
    /** Records a confirmed outbound UUID, evicting the oldest beyond the bound. */
    rememberSentUuid: (uuid: string, identity?: ClaudeSentUserIdentity) =>
      rememberBounded(sentUserUuids, uuid, identity, SENT_UUID_LIMIT),
    hasSentUuid: (uuid: string) => sentUserUuids.has(uuid),
    /** Records a Claude-owned internal replay UUID without treating it as adapter-sent. */
    rememberInternalReplayUuid: (uuid: string) =>
      rememberBounded(internalReplayUuids, uuid, true, SENT_UUID_LIMIT),
    hasInternalReplayUuid: (uuid: string) => internalReplayUuids.has(uuid),
    matchSentContent,
    register,
    take,
    hasOutstandingAssignment: (epoch: number) =>
      resultOrder.some(
        (expectation) => expectation.kind === "assignment" && expectation.epoch === epoch,
      ),
    clear,
  };
};
