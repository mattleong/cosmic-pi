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
  it("refuses before schema decoding when the current allowance is too small", () => {
    const result: BackgroundTaskCommandResult = {
      text: "No background tasks.",
      details: { action: "list", tasks: [] },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 0)).toEqual({ _tag: "Refused" });
    // Exact sizing accepts any output that genuinely fits; the old fixed-slack estimator
    // conservatively refused the ~768-byte boundary window (approved Round-1 delta).
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

  it("retains spawn errors in failed snapshot projections", () => {
    const failedSnapshot = {
      id: snapshot.id,
      command: snapshot.command,
      cwd: snapshot.cwd,
      state: "failed" as const,
      startedAt: snapshot.startedAt,
      endedAt: 2,
      error: "Unable to spawn local process.",
      logCursor: snapshot.logCursor,
      droppedLogBytes: snapshot.droppedLogBytes,
    };
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 failed",
      details: { action: "status", snapshot: failedSnapshot },
    };
    const projection = projectBackgroundTaskCodeModeOutput(result, 4_096);
    expect(projection._tag).toBe("Accepted");
    if (projection._tag !== "Accepted" || projection.output.action !== "status") return;
    expect(projection.output.snapshot.error).toBe("Unable to spawn local process.");
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
    expect(Object.isFrozen(snapshot)).toBe(false);
    expect(Object.isFrozen(projection.output.tasks[0])).toBe(true);
    expect(Object.isFrozen(projection.output.tasks)).toBe(true);
    expect(Object.isFrozen(projection.output)).toBe(true);
  });

  it("strips undeclared producer fields from the detached result", () => {
    const producerSnapshot = { ...snapshot, internalOnly: "remove me" };
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: { action: "status", snapshot: producerSnapshot },
    };
    const projection = projectBackgroundTaskCodeModeOutput(result, 4_096);
    expect(projection._tag).toBe("Accepted");
    if (projection._tag !== "Accepted" || projection.output.action !== "status") return;
    expect(projection.output.snapshot).toEqual(snapshot);
    expect(projection.output.snapshot).not.toHaveProperty("internalOnly");
    expect(projection.output.snapshot).not.toBe(producerSnapshot);
  });

  it.each([
    [
      "snapshot timestamps",
      {
        text: "bg-1 running",
        details: { action: "status", snapshot: { ...snapshot, startedAt: Number.NaN } },
      },
    ],
    [
      "log cursors",
      {
        text: "bg-1 logs",
        details: {
          action: "logs",
          logs: {
            id: snapshot.id,
            events: [],
            nextCursor: -1,
            earliestAvailableCursor: 1,
            droppedBytes: 0,
            state: snapshot.state,
          },
        },
      },
    ],
    [
      "wait byte counts",
      {
        text: "bg-1 timeout",
        details: {
          action: "wait",
          wait: {
            id: snapshot.id,
            outcome: "timeout",
            snapshot,
            nextCursor: 0,
            earliestAvailableCursor: 1,
            droppedBytes: Number.POSITIVE_INFINITY,
          },
        },
      },
    ],
    [
      "clear counts",
      {
        text: "cleared",
        details: { action: "clear", removed: 1.5 },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, BackgroundTaskCommandResult]>)(
    "refuses invalid numeric metadata in %s",
    (_label, result) => {
      expect(projectBackgroundTaskCodeModeOutput(result, 4_096)).toEqual({ _tag: "Refused" });
    },
  );

  it("counts lone surrogates as JSON escapes before decoding", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "\ud800".repeat(1_000) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 4_000)).toEqual({ _tag: "Refused" });
  });

  it("refuses oversized snapshot fields before decoding", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "x".repeat(2_049) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 1_000_000)).toEqual({ _tag: "Refused" });
  });

  it("refuses large text without allocating a detached schema result", () => {
    const result: BackgroundTaskCommandResult = {
      text: "x".repeat(8_000),
      details: { action: "status", snapshot },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 4_096)).toEqual({ _tag: "Refused" });
  });
});
