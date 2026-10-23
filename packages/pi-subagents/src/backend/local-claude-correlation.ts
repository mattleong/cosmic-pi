import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import type { ClaudeProtocolEvent } from "./local-claude-protocol.ts";

export const SENT_UUID_LIMIT = 64;

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

// Turns Claude starts on its own: background-task notifications, continuations, and messages its
// native agents send the main session with SendMessage. Cross-session input stays refused.
const INTERNAL_REPLAY_ORIGINS: ReadonlySet<string> = new Set([
  "task-notification",
  "auto-continuation",
  "peer",
]);

export const isInternalReplayOrigin = (
  originKind: string | undefined,
  originSubkind: string | undefined,
): boolean => originSubkind === undefined && INTERNAL_REPLAY_ORIGINS.has(originKind ?? "");

const hasTaskNotificationEnvelope = (text: string): boolean => {
  const trimmed = Str.trimStart(text);
  return (
    Fn.pipe(trimmed, Str.startsWith("<task-notification>")) &&
    Fn.pipe(trimmed, Str.includes("</task-notification>", "<task-notification>".length))
  );
};

type ClaudeTaskNotificationReplay = "labelled" | "unlabelled";

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
  const tag = /^\s*<([a-z][a-z0-9-]{0,63})(?:\s|>)/u.exec(Fn.pipe(text, Str.slice(0, 256)))?.[1];
  return tag === undefined
    ? "none"
    : Option.getOrElse(
        Arr.findFirst(DIAGNOSTIC_LEADING_TAGS, (known) => known === tag),
        () => "other" as const,
      );
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
  readonly pending: "initialize" | "start" | "steer" | "remind" | "interrupt" | "none";
  readonly report: "accepted" | "none" | "unknown";
  readonly sinceOutbound: ClaudeOutboundAgeDiagnostic;
  readonly traceEnabled: boolean;
}

export const uncorrelatedClaudeUserMessage = (
  event: ClaudeUserProtocolEvent,
  nativeSessionId: string | undefined,
  context: ClaudeUserDiagnosticContext,
): string =>
  Arr.join(
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
    ],
    "; ",
  );

export interface ResultExpectation {
  readonly uuid: string;
  readonly kind: "initialization" | "assignment" | "synthetic";
  readonly epoch: number;
}

export const claudeResultCorrelation = () => {
  const sentUserUuids = new Map<string, ClaudeSentUserIdentity | undefined>();
  const internalReplayUuids = new Map<string, true>();
  const resultExpectations = new Map<string, ResultExpectation>();
  const resultOrder: ResultExpectation[] = [];

  const matchSentContent = (contentDigest: string): ClaudeSentContentMatch => {
    const kinds = new Set<ClaudeSentUserKind>();
    for (const identity of sentUserUuids.values())
      if (identity?.contentDigest === contentDigest) kinds.add(identity.kind);
    if (kinds.size === 0) return "other";
    if (kinds.size > 1) return "multiple";
    return kinds.values().next().value ?? "other";
  };

  const register = (expectation: ResultExpectation): void => {
    const owned = { ...expectation };
    resultExpectations.set(owned.uuid, owned);
    resultOrder.push(owned);
    while (resultOrder.length > SENT_UUID_LIMIT) {
      const synthetic = Option.getOrElse(
        Arr.findFirstIndex(resultOrder, (candidate) => candidate.kind === "synthetic"),
        () => -1,
      );
      const [evicted] = resultOrder.splice(Math.max(0, synthetic), 1);
      if (evicted) resultExpectations.delete(evicted.uuid);
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
    const index = Option.getOrElse(
      isInternalReplayOrigin(originKind, originSubkind)
        ? Arr.findFirstIndex(resultOrder, (candidate) => candidate.kind === "synthetic")
        : Arr.findFirstIndex(resultOrder, (candidate) => candidate.kind !== "synthetic"),
      () => -1,
    );
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
    rememberSentUuid: (uuid: string, identity?: ClaudeSentUserIdentity) =>
      rememberBounded(sentUserUuids, uuid, identity, SENT_UUID_LIMIT),
    hasSentUuid: (uuid: string) => sentUserUuids.has(uuid),
    rememberInternalReplayUuid: (uuid: string) =>
      rememberBounded(internalReplayUuids, uuid, true, SENT_UUID_LIMIT),
    hasInternalReplayUuid: (uuid: string) => internalReplayUuids.has(uuid),
    matchSentContent,
    register,
    take,
    hasOutstandingAssignment: (epoch: number) =>
      Arr.some(
        resultOrder,
        (expectation) => expectation.kind === "assignment" && expectation.epoch === epoch,
      ),
    clear,
  };
};
