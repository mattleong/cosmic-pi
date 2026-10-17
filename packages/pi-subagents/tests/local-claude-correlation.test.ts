import { describe, expect, it } from "vitest";
import {
  claudeResultCorrelation,
  SENT_UUID_LIMIT,
  uncorrelatedClaudeUserMessage,
} from "../src/backend/local-claude-correlation.ts";
import type { ClaudeProtocolEvent } from "../src/backend/local-claude-protocol.ts";

type UserEvent = Extract<ClaudeProtocolEvent, { readonly type: "user" }>;

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
  it("does not let a UUID-less ordinary result consume synthetic ownership", () => {
    const correlation = claudeResultCorrelation();
    correlation.register({ uuid: "synthetic", kind: "synthetic", epoch: 2 });
    correlation.register({ uuid: "assignment", kind: "assignment", epoch: 2 });

    expect(correlation.take(undefined, undefined, undefined)).toMatchObject({
      uuid: "assignment",
      kind: "assignment",
    });
    expect(correlation.take(undefined, "task-notification", undefined)).toMatchObject({
      uuid: "synthetic",
      kind: "synthetic",
    });
  });

  it("never lets Claude-owned subturns evict an adapter-owned result expectation", () => {
    const correlation = claudeResultCorrelation();
    correlation.register({ uuid: "assignment", kind: "assignment", epoch: 4 });
    for (let index = 0; index <= SENT_UUID_LIMIT; index += 1)
      correlation.register({ uuid: `internal-${index}`, kind: "synthetic", epoch: 4 });

    expect(correlation.hasOutstandingAssignment(4)).toBe(true);
    expect(correlation.take("internal-0", undefined, undefined)).toBeUndefined();
    expect(correlation.take(`internal-${SENT_UUID_LIMIT}`, undefined, undefined)?.kind).toBe(
      "synthetic",
    );
    expect(correlation.take("assignment", undefined, undefined)?.kind).toBe("assignment");
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
