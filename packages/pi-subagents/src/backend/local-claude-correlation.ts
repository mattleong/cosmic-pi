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

const diagnosticOrigin = (value: string | undefined, known: ReadonlySet<string>): string =>
  value === undefined ? "absent" : known.has(value) ? value : "other";

/** Fixed-field diagnostics that never retain message text or correlation IDs. */
export const uncorrelatedClaudeUserMessage = (
  event: ClaudeUserProtocolEvent,
  nativeSessionId: string | undefined,
): string => {
  const session =
    event.sessionId === undefined
      ? "absent"
      : nativeSessionId === undefined
        ? "uninitialized"
        : event.sessionId === nativeSessionId
          ? "match"
          : "mismatch";
  return [
    "Claude replayed an uncorrelated stream-input message.",
    `[uuid=${event.uuid === undefined ? "absent" : "present"}`,
    `session=${session}`,
    `replay=${event.isReplay}`,
    `synthetic=${event.isSynthetic}`,
    `origin=${diagnosticOrigin(event.originKind, DIAGNOSTIC_ORIGINS)}`,
    `subkind=${diagnosticOrigin(event.originSubkind, DIAGNOSTIC_ORIGIN_SUBKINDS)}`,
    `parent-tool=${event.parentToolUseId === undefined ? "absent" : "present"}`,
    `tool-results=${event.toolResults.length === 0 ? "none" : "present"}]`,
  ].join("; ");
};

/** Correlates a native result to the exact user input that started its query. */
export interface ResultExpectation {
  readonly uuid: string;
  readonly kind: "initialization" | "assignment" | "synthetic";
  readonly epoch: number;
  /** Global emitted-usage watermark when this exact native query was registered. */
  readonly usageBaseline: UsageComponents;
}

export interface ClaudeResultCorrelation {
  /** Records a confirmed outbound UUID, evicting the oldest beyond the bound. */
  readonly rememberSentUuid: (uuid: string) => void;
  /** True while a UUID remains inside the bounded confirmed-identity window. */
  readonly hasSentUuid: (uuid: string) => boolean;
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
  /** Drops every confirmed UUID and owned expectation (transport shutdown). */
  readonly clear: () => void;
}

export const makeClaudeResultCorrelation = (): ClaudeResultCorrelation => {
  const sentUserUuids = new Set<string>();
  const resultExpectations = new Map<string, ResultExpectation>();
  /** FIFO used only when the current protocol legitimately omits user_message_uuid. */
  const resultOrder: ResultExpectation[] = [];

  const rememberSentUuid = (uuid: string): void => {
    sentUserUuids.delete(uuid);
    sentUserUuids.add(uuid);
    while (sentUserUuids.size > SENT_UUID_LIMIT) {
      const oldest = sentUserUuids.values().next().value;
      if (oldest === undefined) break;
      sentUserUuids.delete(oldest);
    }
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
    resultExpectations.clear();
    resultOrder.length = 0;
  };

  return {
    rememberSentUuid,
    hasSentUuid: (uuid) => sentUserUuids.has(uuid),
    register,
    take,
    clear,
  };
};
