/**
 * Pure usage arithmetic and UUID/result correlation bookkeeping for the local
 * Claude adapter. `makeLocalClaudeHandle` remains the owner of report
 * buffering, interrupt lifecycles, control responses, the assignment epoch,
 * and initialization; this module only tracks what was sent and which native
 * result each issued input owns.
 */
import type { ClaudeProtocolEvent } from "./local-claude-protocol.ts";

/** Cumulative native usage components tracked for monotone delta accounting. */
export interface UsageComponents {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const zeroUsageComponents: UsageComponents = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const componentwiseMax = (
  left: UsageComponents,
  right: UsageComponents,
): UsageComponents => ({
  input: Math.max(left.input, right.input),
  output: Math.max(left.output, right.output),
  cacheRead: Math.max(left.cacheRead, right.cacheRead),
  cacheWrite: Math.max(left.cacheWrite, right.cacheWrite),
});

export const addUsageComponents = (
  left: UsageComponents,
  right: UsageComponents,
): UsageComponents => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
});

export interface CumulativeUsageDelta {
  readonly delta: UsageComponents;
  readonly inconsistent: boolean;
}

/**
 * Nonnegative componentwise delta between cumulative native usage snapshots.
 * A regressing native total is reported as inconsistent and never subtracted.
 */
export const cumulativeUsageDelta = (
  previous: UsageComponents,
  next: UsageComponents,
): CumulativeUsageDelta => ({
  delta: {
    input: Math.max(0, next.input - previous.input),
    output: Math.max(0, next.output - previous.output),
    cacheRead: Math.max(0, next.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, next.cacheWrite - previous.cacheWrite),
  },
  inconsistent:
    next.input < previous.input ||
    next.output < previous.output ||
    next.cacheRead < previous.cacheRead ||
    next.cacheWrite < previous.cacheWrite,
});

export const usageComponentsTotal = (components: UsageComponents): number =>
  components.input + components.output + components.cacheRead + components.cacheWrite;

/** Bound shared by the confirmed-UUID window and the result-expectation FIFO. */
export const SENT_UUID_LIMIT = 64;

export type ClaudeSentUserKind = "probe" | "assignment" | "steer";
export type ClaudeSentContentMatch = ClaudeSentUserKind | "multiple" | "other";

export interface ClaudeSentUserIdentity {
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

/**
 * Claude 2.1.259's command-queue replay omits synthetic/origin metadata for a
 * pending task notification. This complete fixed envelope is protocol evidence,
 * not content identity: its UUID still cannot confirm any adapter input.
 */
export const isClaudeQueuedTaskNotificationReplay = (
  event: Extract<ClaudeProtocolEvent, { readonly type: "user" }>,
): boolean => {
  if (
    !event.isReplay ||
    event.isSynthetic ||
    event.isMeta ||
    event.isCompactSummary ||
    event.uuid === undefined ||
    event.sessionId === undefined ||
    event.parentToolUseId !== undefined ||
    event.originKind !== undefined ||
    event.originSubkind !== undefined ||
    event.toolResults.length > 0 ||
    event.contentKind !== "text"
  )
    return false;
  const text = event.text.trimStart();
  return (
    text.startsWith("<task-notification>") &&
    text.indexOf("</task-notification>", "<task-notification>".length) >= 0
  );
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

export type ClaudeSessionDiagnostic = "absent" | "uninitialized" | "match" | "mismatch";

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

const DIAGNOSTIC_LEADING_TAGS: ReadonlySet<string> = new Set([
  "task-notification",
  "system-reminder",
  "teammate-message",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
]);

export type ClaudeTextLengthDiagnostic = "empty" | "1-64" | "65-1024" | "1025-16384" | "over-16384";

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
  | "task-notification"
  | "system-reminder"
  | "teammate-message"
  | "local-command-stdout"
  | "local-command-stderr"
  | "local-command-caveat";

export const claudeLeadingTagDiagnostic = (text: string): ClaudeLeadingTagDiagnostic => {
  const match = /^\s*<([a-z][a-z0-9-]{0,63})(?:\s|>)/u.exec(text.slice(0, 256));
  if (!match) return "none";
  const tag = match[1];
  if (!tag || !DIAGNOSTIC_LEADING_TAGS.has(tag)) return "other";
  switch (tag) {
    case "task-notification":
    case "system-reminder":
    case "teammate-message":
    case "local-command-stdout":
    case "local-command-stderr":
    case "local-command-caveat":
      return tag;
    default:
      return "other";
  }
};

export type ClaudeOutboundAgeDiagnostic = "none" | "under-1s" | "1-10s" | "11-60s" | "over-60s";

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

export interface ClaudeResultCorrelation {
  /** Records a confirmed outbound UUID and optional content identity, evicting the oldest beyond the bound. */
  readonly rememberSentUuid: (uuid: string, identity?: ClaudeSentUserIdentity) => void;
  /** True while a UUID remains inside the bounded confirmed-identity window. */
  readonly hasSentUuid: (uuid: string) => boolean;
  /** Records a Claude-owned internal replay UUID without treating it as adapter-sent. */
  readonly rememberInternalReplayUuid: (uuid: string) => void;
  /** True while a UUID remains in the bounded Claude-owned internal window. */
  readonly hasInternalReplayUuid: (uuid: string) => boolean;
  /** Classifies an inbound digest against the bounded confirmed-input window. */
  readonly matchSentContent: (contentDigest: string) => ClaudeSentContentMatch;
  /** Registers one owned result expectation with a snapshot usage baseline. */
  readonly register: (
    expectation: Omit<ResultExpectation, "usageBaseline">,
    usageBaseline: UsageComponents,
  ) => void;
  /**
   * Takes the expectation for a native result: the exact `user_message_uuid`
   * when reported; otherwise the oldest synthetic expectation for a
   * Claude-owned internal replay origin, or the issue-order FIFO head for a
   * pinned protocol frame that legitimately omits the UUID.
   */
  readonly take: (
    userMessageUuid: string | undefined,
    originKind: string | undefined,
    originSubkind: string | undefined,
  ) => ResultExpectation | undefined;
  /** True while an assignment result remains owned for the exact epoch. */
  readonly hasOutstandingAssignment: (epoch: number) => boolean;
  /** Drops every confirmed UUID and owned expectation (transport shutdown). */
  readonly clear: () => void;
}

export const makeClaudeResultCorrelation = (): ClaudeResultCorrelation => {
  const sentUserUuids = new Map<string, ClaudeSentUserIdentity | undefined>();
  const internalReplayUuids = new Set<string>();
  const resultExpectations = new Map<string, ResultExpectation>();
  /** FIFO used only when the current protocol legitimately omits user_message_uuid. */
  const resultOrder: ResultExpectation[] = [];

  const rememberSentUuid = (uuid: string, identity?: ClaudeSentUserIdentity): void => {
    sentUserUuids.delete(uuid);
    sentUserUuids.set(uuid, identity);
    while (sentUserUuids.size > SENT_UUID_LIMIT) {
      const oldest = sentUserUuids.keys().next().value;
      if (oldest === undefined) break;
      sentUserUuids.delete(oldest);
    }
  };

  const rememberInternalReplayUuid = (uuid: string): void => {
    internalReplayUuids.delete(uuid);
    internalReplayUuids.add(uuid);
    while (internalReplayUuids.size > SENT_UUID_LIMIT) {
      const oldest = internalReplayUuids.values().next().value;
      if (oldest === undefined) break;
      internalReplayUuids.delete(oldest);
    }
  };

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
      const oldest = resultOrder.shift();
      if (oldest) resultExpectations.delete(oldest.uuid);
    }
  };

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
    rememberSentUuid,
    hasSentUuid: (uuid) => sentUserUuids.has(uuid),
    rememberInternalReplayUuid,
    hasInternalReplayUuid: (uuid) => internalReplayUuids.has(uuid),
    matchSentContent,
    register,
    take,
    hasOutstandingAssignment: (epoch) =>
      resultOrder.some(
        (expectation) => expectation.kind === "assignment" && expectation.epoch === epoch,
      ),
    clear,
  };
};
