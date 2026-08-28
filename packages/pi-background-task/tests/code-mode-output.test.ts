import { describe, expect, it } from "vitest";
import { projectBackgroundTaskCodeModeOutput } from "../src/code-mode/output.ts";
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
  it("refuses before copying when the current allowance is too small", () => {
    const result: BackgroundTaskCommandResult = {
      text: "No background tasks.",
      details: { action: "list", tasks: [] },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 0)).toEqual({ _tag: "Refused" });
    expect(projectBackgroundTaskCodeModeOutput(result, 128)).toEqual({ _tag: "Refused" });
  });

  it("returns frozen detached snapshots within the allowance", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: { action: "list", tasks: [snapshot] },
    };
    const projection = projectBackgroundTaskCodeModeOutput(result, 4_096);
    expect(projection._tag).toBe("Accepted");
    if (projection._tag !== "Accepted" || projection.output.action !== "list") return;
    expect(projection.output.tasks).toEqual([snapshot]);
    expect(projection.output.tasks[0]).not.toBe(snapshot);
    expect(Object.isFrozen(projection.output.tasks[0])).toBe(true);
    expect(Object.isFrozen(projection.output.tasks)).toBe(true);
  });

  it("counts lone surrogates as JSON escapes before copying", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "\ud800".repeat(1_000) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 4_000)).toEqual({ _tag: "Refused" });
  });

  it("refuses oversized snapshot fields before copying", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "x".repeat(2_049) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 1_000_000)).toEqual({ _tag: "Refused" });
  });

  it("refuses large text without allocating a compact JSON copy", () => {
    const result: BackgroundTaskCommandResult = {
      text: "x".repeat(8_000),
      details: { action: "status", snapshot },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 4_096)).toEqual({ _tag: "Refused" });
  });
});
