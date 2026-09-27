import { describe, expect, it } from "vitest";
import {
  backgroundTaskCodeModeStartOutputFits,
  projectBackgroundTaskCodeModeOutput,
} from "../src/code-mode/output.ts";
import type { BackgroundTaskCommandResult } from "../src/tools/command.ts";

const snapshot = {
  id: "bg-1",
  command: "node server.js",
  cwd: "/project",
  state: "running" as const,
  pid: 42,
  startedAt: 1,
  logCursor: 0,
  droppedLogBytes: 0,
};

describe("Background Tasks Code Mode output projection", () => {
  it("round-trips command results", () => {
    const logs = {
      id: snapshot.id,
      nextCursor: 2,
      earliestAvailableCursor: 1,
      droppedBytes: 0,
      state: snapshot.state,
    };
    const details: BackgroundTaskCommandResult["details"][] = [
      ...(["start", "status", "stop"] as const).map((action) => ({ action, snapshot })),
      ...(["list", "stop_all"] as const).map((action) => ({ action, tasks: [snapshot] })),
      { action: "logs", logs },
      {
        action: "wait",
        wait: {
          id: snapshot.id,
          nextCursor: 2,
          earliestAvailableCursor: 1,
          droppedBytes: 0,
          outcome: "matched",
          snapshot,
          matchCursor: 2,
        },
      },
      { action: "clear", removed: 3 },
      {
        action: "status",
        snapshot: {
          ...snapshot,
          state: "failed",
          endedAt: 2,
          error: "Unable to spawn local process.",
        },
      },
    ];
    for (const item of details) {
      const result = { text: item.action, details: item };
      expect(projectBackgroundTaskCodeModeOutput(result, 4_096)).toEqual({
        _tag: "Accepted",
        output: { text: result.text, ...item },
      });
    }
  });

  it("refuses output exceeding the current allowance", () => {
    const result: BackgroundTaskCommandResult = {
      text: "No background tasks.",
      details: { action: "list", tasks: [] },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 0)).toEqual({ _tag: "Refused" });
    expect(projectBackgroundTaskCodeModeOutput(result, 128)).toEqual({
      _tag: "Accepted",
      output: { action: "list", text: "No background tasks.", tasks: [] },
    });
  });

  it("bounds successful starts without reserving impossible process-exit error text", () => {
    const request = {
      command: "node server.js",
      cwd: "/project",
      name: "server",
    };
    expect(backgroundTaskCodeModeStartOutputFits(request, 0, 0)).toBe(false);
    expect(backgroundTaskCodeModeStartOutputFits(request, 4_096, 2_048)).toBe(true);
    expect(
      backgroundTaskCodeModeStartOutputFits(
        { ...request, cwd: "x".repeat(1_025) },
        1_000_000,
        1_000_000,
      ),
    ).toBe(false);
  });

  it("returns frozen detached snapshots without undeclared producer fields", () => {
    // The details-only failure line never enters the frozen Code Mode contract.
    const producerSnapshot = { ...snapshot, internalOnly: "remove me", failureLine: "FAIL x" };
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: { action: "list", tasks: [producerSnapshot] },
    };
    const projection = projectBackgroundTaskCodeModeOutput(result, 4_096);
    expect(projection._tag).toBe("Accepted");
    if (projection._tag !== "Accepted" || projection.output.action !== "list") return;
    expect(projection.output.tasks).toEqual([snapshot]);
    expect(projection.output.tasks[0]).not.toHaveProperty("internalOnly");
    expect(projection.output.tasks[0]).not.toHaveProperty("failureLine");
    expect(projection.output.tasks[0]).not.toBe(producerSnapshot);
    expect(Object.isFrozen(producerSnapshot)).toBe(false);
    expect(Object.isFrozen(projection.output.tasks[0])).toBe(true);
    expect(Object.isFrozen(projection.output.tasks)).toBe(true);
    expect(Object.isFrozen(projection.output)).toBe(true);
  });

  it("counts lone surrogates as JSON escapes against the allowance", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "\ud800".repeat(1_000) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 4_000)).toEqual({ _tag: "Refused" });
  });

  it("refuses oversized snapshot fields even with a sufficient byte allowance", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "x".repeat(2_049) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 1_000_000)).toEqual({ _tag: "Refused" });
  });
});
