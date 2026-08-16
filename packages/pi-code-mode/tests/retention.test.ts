import { describe, expect, it } from "vitest";
import {
  applyRetainedCodeModeFailureDetails,
  makeFailureDetailsRetention,
} from "../src/tools/retention.ts";

const details = (tool: string) => ({
  toolCalls: [{ tool, status: "error" as const, activity: `Call ${tool}` }],
  counts: {
    total: 1,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 1,
    cancelled: 0,
  },
});

describe("failure details retention", () => {
  it("defensively retains and consumes details once", () => {
    const retention = makeFailureDetailsRetention();
    const value = details("pi.read");
    retention.retain("a", value);
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    (value.toolCalls[0] as { tool: string }).tool = "mutated";
    expect(retention.consume("a")?.toolCalls[0]?.tool).toBe("pi.read");
    expect(retention.consume("a")).toBeUndefined();
  });

  it("reattaches only owned thrown-error details and consumes them once", () => {
    const retention = makeFailureDetailsRetention();
    retention.retain("owned", details("pi.bash"));
    expect(
      applyRetainedCodeModeFailureDetails(retention, {
        toolName: "read",
        toolCallId: "owned",
        isError: true,
      }),
    ).toBeUndefined();
    expect(
      applyRetainedCodeModeFailureDetails(retention, {
        toolName: "code_mode",
        toolCallId: "owned",
        isError: false,
      }),
    ).toBeUndefined();
    expect(
      applyRetainedCodeModeFailureDetails(retention, {
        toolName: "code_mode",
        toolCallId: "owned",
        isError: true,
      })?.details.toolCalls[0]?.tool,
    ).toBe("pi.bash");
    expect(
      applyRetainedCodeModeFailureDetails(retention, {
        toolName: "code_mode",
        toolCallId: "owned",
        isError: true,
      }),
    ).toBeUndefined();
  });

  it("evicts the oldest entry at capacity", () => {
    const retention = makeFailureDetailsRetention(2);
    retention.retain("a", details("a"));
    retention.retain("b", details("b"));
    retention.retain("c", details("c"));
    expect(retention.consume("a")).toBeUndefined();
    expect(retention.consume("b")?.toolCalls[0]?.tool).toBe("b");
    expect(retention.consume("c")?.toolCalls[0]?.tool).toBe("c");
  });
});
