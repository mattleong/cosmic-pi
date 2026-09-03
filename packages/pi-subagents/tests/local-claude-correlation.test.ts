import { describe, expect, it } from "vitest";
import {
  isClaudeQueuedTaskNotificationReplay,
  isInternalReplayOrigin,
  makeClaudeResultCorrelation,
  SENT_UUID_LIMIT,
  uncorrelatedClaudeUserMessage,
  zeroUsageComponents,
} from "../src/backend/local-claude-correlation.ts";
import type { ClaudeProtocolEvent } from "../src/backend/local-claude-protocol.ts";

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

  it("recognizes only the complete metadata-deficient task-notification replay envelope", () => {
    const replay: Extract<ClaudeProtocolEvent, { readonly type: "user" }> = {
      type: "user",
      text: "<task-notification><status>completed</status></task-notification>",
      textLength: 65,
      contentKind: "text",
      toolResults: [],
      uuid: "internal-notification",
      sessionId: "native-session",
      isSynthetic: false,
      isReplay: true,
      isMeta: false,
      isCompactSummary: false,
    };
    expect(isClaudeQueuedTaskNotificationReplay(replay)).toBe(true);
    for (const nearMiss of [
      { ...replay, uuid: undefined },
      { ...replay, sessionId: undefined },
      { ...replay, isReplay: false },
      { ...replay, isSynthetic: true },
      { ...replay, isMeta: true },
      { ...replay, isCompactSummary: true },
      { ...replay, originKind: "channel" },
      { ...replay, parentToolUseId: "native-tool" },
      { ...replay, contentKind: "blocks" as const },
      { ...replay, text: "<task-notification>missing close" },
    ])
      expect(isClaudeQueuedTaskNotificationReplay(nearMiss)).toBe(false);
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
      {
        type: "user",
        text: `<teammate-message>${secret}</teammate-message>`,
        textLength: 57,
        contentKind: "text",
        toolResults: [],
        uuid: "secret-uuid",
        sessionId: "secret-session",
        parentToolUseId: "secret-tool",
        originKind: "future-origin",
        originSubkind: "future-subkind",
        isSynthetic: false,
        isReplay: true,
        isMeta: false,
        isCompactSummary: false,
      },
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
