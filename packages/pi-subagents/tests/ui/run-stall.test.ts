import { describe, expect, it } from "vitest";
import { runStall, STALL_IDLE_MILLIS, STALL_TOOL_OPEN_MILLIS } from "../../src/run/stall.ts";
import type { SubagentSessionEvent } from "../../src/run/model.ts";

const tool = (
  state: "running" | "completed" | "failed",
  startedAt: number,
  toolName = "bash",
): SubagentSessionEvent => ({
  type: "tool",
  toolCallId: `${toolName}-${startedAt}`,
  toolName,
  state,
  startedAt,
});

const running = (sessionEvents: ReadonlyArray<SubagentSessionEvent>, lastActivityAt = 0) => ({
  state: "running" as const,
  lastActivityAt,
  sessionEvents,
});

describe("run stall signals", () => {
  it("flags a tool that has been open too long", () => {
    expect(runStall(running([tool("running", 0)]), STALL_TOOL_OPEN_MILLIS)).toMatchObject({
      kind: "tool-open",
      toolName: "bash",
    });
    expect(runStall(running([tool("running", 0)]), STALL_TOOL_OPEN_MILLIS - 1)).toBeUndefined();
  });

  it("flags consecutive failed tools until one succeeds", () => {
    const failing = [tool("failed", 1), tool("failed", 2), tool("failed", 3)];
    expect(runStall(running(failing, 3), 4)).toEqual({ kind: "failing-tools", count: 3 });
    expect(runStall(running([...failing, tool("completed", 4)], 4), 5)).toBeUndefined();
  });

  it("flags silence only while no tool is open and only for running children", () => {
    expect(runStall(running([], 0), STALL_IDLE_MILLIS)).toMatchObject({ kind: "idle" });
    expect(runStall(running([tool("running", 0)], 0), STALL_IDLE_MILLIS)).toBeUndefined();
    expect(
      runStall({ ...running([], 0), state: "waiting_for_parent" }, STALL_IDLE_MILLIS * 10),
    ).toBeUndefined();
  });
});
