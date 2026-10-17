import { describe, expect, it } from "vitest";
import type { CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

type Input = Parameters<typeof projectBackgroundTaskCompactSummary>[0];
const snapshot = {
  id: "task-1",
  command: "test",
  cwd: "/tmp",
  state: "running",
  startedAt: 1,
  logCursor: 10,
  droppedLogBytes: 0,
};
const cursors = { nextCursor: 10, earliestAvailableCursor: 0, droppedBytes: 0 };
type Snapshot = typeof snapshot & { readonly exitCode?: number | null };
const project = (
  details: NonNullable<Input["result"]>["details"],
  action: BackgroundTaskToolInput["action"] = "status",
  phase: Input["phase"] = "settled",
  isError = false,
  args: Partial<BackgroundTaskToolInput> = {},
) =>
  projectBackgroundTaskCompactSummary({
    phase,
    args: { ...args, action },
    result: { details },
    isError,
  });
const logs = (state = "running", fields: Partial<typeof cursors> = {}, truncated?: boolean) => ({
  action: "logs",
  logs: { id: snapshot.id, state, ...cursors, ...fields },
  ...(truncated !== undefined && {
    truncation: {
      truncated,
      outputBytes: 20,
      totalBytes: truncated ? 50 : 20,
      outputLines: 2,
      totalLines: truncated ? 5 : 2,
    },
  }),
});
const wait = (
  outcome: string,
  waitSnapshot: Snapshot = snapshot,
  fields: Partial<typeof cursors & { id: string }> = {},
) => ({
  action: "wait",
  wait: { id: snapshot.id, snapshot: waitSnapshot, outcome, ...cursors, ...fields },
});
type Summary = ReturnType<typeof project>;
const find = (summary: Summary, code: string): CompactIssue | undefined =>
  summary?.issues?.find((issue) => issue.code === code);

describe("background task compact semantics", () => {
  it("declines missing, malformed and unrelated details rather than inventing success", () => {
    for (const details of [
      undefined,
      null,
      {},
      { action: "status" },
      { action: "status", snapshot: { state: "exited" } },
      { action: "status", snapshot: { ...snapshot, droppedLogBytes: undefined } },
    ])
      expect(project(details)).toBeUndefined();
    expect(project({ action: "clear", removed: 1 })).toBeUndefined();
  });

  it.each([
    [{ state: "exited", exitCode: 2 }, "error", "exit-code", "error"],
    [{ state: "exited", signal: "SIGKILL", exitCode: null }, "error", "signal", "error"],
    [{ state: "timed_out" }, "error", "runtime-timeout", "error"],
    [{ state: "failed" }, "error", "failed", "error"],
    [{ state: "failed", exitCode: 0 }, "error", "failed", "error"],
    [{ state: "stopping" }, "uncertain", "cleanup-unconfirmed", "warning"],
    [{ state: "exited" }, "uncertain", "exit-unknown", "warning"],
  ])("projects status causes as issues: %j", (fields, outcome, code, severity) => {
    const result = project({ action: "status", snapshot: { ...snapshot, ...fields } });
    expect(result?.outcome).toBe(outcome);
    expect(find(result, `task-1:${code}`)?.severity).toBe(severity);
  });

  it("writes every issue message in the shared style, without task IDs", () => {
    const snapshots = [
      { ...snapshot, state: "failed", error: "Error: spawn ENOENT\n  at spawn" },
      { ...snapshot, state: "failed" },
      { ...snapshot, state: "exited", exitCode: 2 },
      { ...snapshot, state: "failed", exitCode: 127 },
      { ...snapshot, state: "exited", exitCode: null },
      { ...snapshot, state: "stopped", signal: "SIGTERM" },
      { ...snapshot, state: "timed_out" },
      { ...snapshot, state: "stopping", droppedLogBytes: 20 },
    ];
    const summaries = [
      ...snapshots.map((value) => project({ action: "status", snapshot: value })),
      project(
        {
          action: "list",
          tasks: snapshots.map((value, index) => ({ ...value, id: `task-${index}` })),
        },
        "list",
      ),
      project(logs("failed", {}, true), "logs"),
      project(logs("timed_out"), "logs"),
      project(logs("running", { droppedBytes: 18_432 }), "logs"),
      project({ ...wait("timeout", snapshot), appliedWaitSeconds: 30 }, "wait", "settled", false, {
        until: "output",
        contains: "ready in",
        waitSeconds: 30,
      }),
      project(wait("timeout", snapshot), "wait"),
    ];
    const issues = summaries.flatMap((summary) => summary?.issues ?? []);
    expect(issues.length).toBeGreaterThan(snapshots.length);
    for (const { message } of issues)
      expect({
        message,
        problems: issueMessageStyleProblems(message, { forbidden: ["task-1"] }),
      }).toEqual({
        message,
        problems: [],
      });
  });
});
