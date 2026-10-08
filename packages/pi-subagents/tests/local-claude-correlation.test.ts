import { describe, expect, it } from "vitest";
import {
  claudeTaskNotificationReplay,
  isInternalReplayOrigin,
  makeClaudeResultCorrelation,
  SENT_UUID_LIMIT,
  uncorrelatedClaudeUserMessage,
} from "../src/backend/local-claude-correlation.ts";
import type { ClaudeProtocolEvent } from "../src/backend/local-claude-protocol.ts";
import { zeroUsageComponents } from "../src/backend/local-claude-usage.ts";

type UserEvent = Extract<ClaudeProtocolEvent, { readonly type: "user" }>;

/** A plain replayed top-level user text frame; tests override only the fields they classify. */
const userEvent = (overrides: Partial<UserEvent>): UserEvent => ({
  type: "user",
  text: "",
  textLength: 0,
  contentKind: "text",
  toolResults: [],
  isSynthetic: false,
  isReplay: true,
  isMeta: false,
  isCompactSummary: false,
  ...overrides,
});

describe("local Claude result correlation", () => {
  it("separates internal notifications from externally qualified task deliveries", () => {
    expect(isInternalReplayOrigin("task-notification", undefined)).toBe(true);
    expect(isInternalReplayOrigin("auto-continuation", undefined)).toBe(true);
    expect(isInternalReplayOrigin("task-notification", "peer-send-message")).toBe(false);
    expect(isInternalReplayOrigin("task-notification", "scheduled-trigger")).toBe(false);
  });

  it("does not let a UUID-less ordinary result consume synthetic ownership", () => {
    const correlation = makeClaudeResultCorrelation();
    correlation.register({ uuid: "synthetic", kind: "synthetic", epoch: 2 }, zeroUsageComponents);
    correlation.register({ uuid: "assignment", kind: "assignment", epoch: 2 }, zeroUsageComponents);

    expect(correlation.take(undefined, undefined, undefined)).toMatchObject({
      uuid: "assignment",
      kind: "assignment",
    });
    expect(correlation.take(undefined, "task-notification", undefined)).toMatchObject({
      uuid: "synthetic",
      kind: "synthetic",
    });
  });

  it("recognizes only complete task-notification replay envelopes, labelled or not", () => {
    const replay = userEvent({
      text: "<task-notification><status>completed</status></task-notification>",
      textLength: 65,
      uuid: "internal-notification",
      sessionId: "native-session",
    });
    const labelled = { ...replay, originKind: "task-notification" };
    expect(claudeTaskNotificationReplay(replay)).toBe("unlabelled");
    expect(claudeTaskNotificationReplay(labelled)).toBe("labelled");
    for (const envelope of [replay, labelled])
      for (const nearMiss of [
        { ...envelope, uuid: undefined },
        { ...envelope, sessionId: undefined },
        { ...envelope, isReplay: false },
        { ...envelope, isSynthetic: true },
        { ...envelope, isMeta: true },
        { ...envelope, isCompactSummary: true },
        { ...envelope, originKind: "channel" },
        { ...envelope, originKind: "auto-continuation" },
        { ...envelope, originKind: "task-notification", originSubkind: "peer-send-message" },
        { ...envelope, originSubkind: "scheduled-trigger" },
        { ...envelope, parentToolUseId: "native-tool" },
        { ...envelope, toolResults: [{ id: "native-tool", isError: false }] },
        { ...envelope, contentKind: "blocks" as const },
        { ...envelope, text: "<task-notification>missing close" },
        { ...envelope, text: "A background command completed." },
      ])
        expect(claudeTaskNotificationReplay(nearMiss)).toBeUndefined();
  });

  it("never lets Claude-owned subturns evict an adapter-owned result expectation", () => {
    const correlation = makeClaudeResultCorrelation();
    correlation.register({ uuid: "assignment", kind: "assignment", epoch: 4 }, zeroUsageComponents);
    for (let index = 0; index <= SENT_UUID_LIMIT; index += 1)
      correlation.register(
        { uuid: `internal-${index}`, kind: "synthetic", epoch: 4 },
        zeroUsageComponents,
      );

    expect(correlation.hasOutstandingAssignment(4)).toBe(true);
    expect(correlation.take("internal-0", undefined, undefined)).toBeUndefined();
    expect(correlation.take(`internal-${SENT_UUID_LIMIT}`, undefined, undefined)?.kind).toBe(
      "synthetic",
    );
    expect(correlation.take("assignment", undefined, undefined)?.kind).toBe("assignment");
  });

  it("keeps Claude-owned replay UUIDs separate from adapter-sent identity", () => {
    const correlation = makeClaudeResultCorrelation();
    correlation.rememberInternalReplayUuid("internal-notification");
    expect(correlation.hasInternalReplayUuid("internal-notification")).toBe(true);
    expect(correlation.hasSentUuid("internal-notification")).toBe(false);
    expect(correlation.matchSentContent("notification-digest")).toBe("other");

    correlation.register({ uuid: "assignment", kind: "assignment", epoch: 3 }, zeroUsageComponents);
    expect(correlation.hasOutstandingAssignment(3)).toBe(true);
    expect(correlation.take("assignment", undefined, undefined)?.kind).toBe("assignment");
    expect(correlation.hasOutstandingAssignment(3)).toBe(false);
  });

  it("classifies content only while its confirmed UUID remains in the bounded window", () => {
    const correlation = makeClaudeResultCorrelation();
    correlation.rememberSentUuid("probe", { contentDigest: "same", kind: "probe" });
    correlation.rememberSentUuid("assignment", {
      contentDigest: "same",
      kind: "assignment",
    });
    expect(correlation.matchSentContent("same")).toBe("multiple");

    for (let index = 0; index < SENT_UUID_LIMIT; index += 1)
      correlation.rememberSentUuid(`later-${index}`, {
        contentDigest: `digest-${index}`,
        kind: "steer",
      });

    expect(correlation.hasSentUuid("probe")).toBe(false);
    expect(correlation.hasSentUuid("assignment")).toBe(false);
    expect(correlation.matchSentContent("same")).toBe("other");
    expect(correlation.matchSentContent(`digest-${SENT_UUID_LIMIT - 1}`)).toBe("steer");
  });

  it("emits useful replay classification without message or identity values", () => {
    const secret = "secret-prompt-value";
    const message = uncorrelatedClaudeUserMessage(
      userEvent({
        text: `<teammate-message>${secret}</teammate-message>`,
        textLength: 57,
        uuid: "secret-uuid",
        sessionId: "secret-session",
        parentToolUseId: "secret-tool",
        originKind: "future-origin",
        originSubkind: "future-subkind",
      }),
      "different-native-session",
      {
        sequence: 17,
        contentMatch: "other",
        pending: "none",
        report: "none",
        sinceOutbound: "over-60s",
        traceEnabled: true,
      },
    );

    expect(message.length).toBeLessThanOrEqual(512);
    expect(message).toContain("sequence=17");
    expect(message).toContain("session=mismatch");
    expect(message).toContain("tag=teammate-message");
    expect(message).toContain("origin=other");
    expect(message).toContain("trace=enabled");
    for (const value of [secret, "secret-uuid", "secret-session", "secret-tool"])
      expect(message).not.toContain(value);
  });
});
