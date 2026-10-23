import { describe, expect, it } from "vitest";
import type { CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../src/task/bounds.ts";
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
type Snapshot = typeof snapshot & {
  readonly exitCode?: number | null;
  readonly name?: string;
  readonly failureCause?: string;
};
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
const logs = (
  state = "running",
  fields: Partial<typeof cursors> = {},
  omitted?: "earlier" | "later",
) => ({
  action: "logs",
  logs: { id: snapshot.id, state, ...cursors, ...fields },
  task: { command: snapshot.command },
  ...(omitted && {
    truncation: { omitted, omittedBytes: 30_000, resumeAfterCursor: 7, cutBytes: 2_048 },
  }),
});
const wait = (
  outcome: string,
  waitSnapshot: Snapshot = snapshot,
  fields: Partial<typeof cursors & { id: string; matchCursor: number }> = {},
  appliedWaitSeconds = 30,
) => ({
  action: "wait",
  wait: { id: snapshot.id, snapshot: waitSnapshot, outcome, ...cursors, ...fields },
  appliedWaitSeconds,
});
type Summary = ReturnType<typeof project>;
const find = (summary: Summary, code: string): CompactIssue | undefined =>
  summary?.issues?.find((issue) => issue.code === code);

describe("background task compact semantics", () => {
  it("bounds the call subject of a maximum-size command to the display limit", () => {
    const command = "x".repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes);
    const summary = project({}, "start", "running", false, { command });
    expect(summary?.subject?.length).toBeLessThanOrEqual(
      BACKGROUND_TASK_FIELD_BOUNDS.maxCommandDisplayChars,
    );
  });

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
      project(logs("failed", {}, "later"), "logs"),
      project(logs("running", {}, "earlier"), "logs"),
      project(logs("timed_out"), "logs"),
      project(logs("running", { droppedBytes: 18_432 }), "logs"),
      project(wait("timeout", snapshot), "wait", "settled", false, {
        until: "output",
        contains: "ready in",
        waitSeconds: 120,
      }),
      project(wait("timeout", snapshot, {}, 0), "wait"),
      project(
        wait("completed", {
          ...snapshot,
          state: "failed",
          exitCode: 1,
          failureCause: "FAIL tests/auth.test.ts > adds",
        }),
        "wait",
      ),
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

describe("background task row outcomes", () => {
  const exited = { ...snapshot, state: "exited", exitCode: 0, endedAt: 2 };
  const stopped = { ...snapshot, state: "stopped", exitCode: null, signal: "SIGTERM", endedAt: 2 };
  const failed = { ...snapshot, state: "failed", exitCode: 1, endedAt: 2 };

  it.each([
    ["a running task's status", { action: "status", snapshot }, "status", "returned"],
    ["a started task", { action: "start", snapshot }, "start", "returned"],
    ["a cleanly exited task", { action: "status", snapshot: exited }, "status", "success"],
    ["a stopped task's status", { action: "status", snapshot: stopped }, "status", "cancelled"],
    [
      "a confirmed stop",
      { action: "stop", snapshot: stopped, alreadyFinished: false },
      "stop",
      "success",
    ],
    [
      "a stop of a finished task",
      { action: "stop", snapshot: failed, alreadyFinished: true },
      "stop",
      "returned",
    ],
    [
      "a stop of every task",
      { action: "stop_all", tasks: [stopped, stopped] },
      "stop_all",
      "success",
    ],
    ["a list of running tasks", { action: "list", tasks: [snapshot] }, "list", "returned"],
    ["a list of finished tasks", { action: "list", tasks: [exited] }, "list", "success"],
    ["an empty list", { action: "list", tasks: [] }, "list", "returned"],
    ["a list with a failure", { action: "list", tasks: [snapshot, failed] }, "list", "error"],
    ["matched output", wait("matched", snapshot, { matchCursor: 4 }), "wait", "success"],
    ["a timed-out wait", wait("timeout", snapshot), "wait", "warning"],
    ["a running task's logs", logs("running"), "logs", "returned"],
    ["a finished task's logs", logs("exited"), "logs", "success"],
  ] as const)("classifies %s", (_label, details, action, outcome) => {
    expect(project(details, action)?.outcome).toBe(outcome);
  });

  it("reports a stop of a finished task without repeating its failure", () => {
    const summary = project({ action: "stop", snapshot: failed, alreadyFinished: true }, "stop");
    expect(summary?.issues ?? []).toEqual([]);
    expect(summary?.metadata?.join(" ")).toContain("failed");
  });

  it("renders the failure cause stored in details", () => {
    const failureCause = "FAIL tests/auth.test.ts > adds";
    const summary = project({ action: "status", snapshot: { ...failed, failureCause } });
    expect(find(summary, "task-1:exit-code")?.message).toContain(failureCause);
  });

  it("keeps each task's label in aggregate issues, even for error-like names", () => {
    const tasks = [
      { ...failed, id: "task-1", name: "BuildError" },
      { ...failed, id: "task-2", name: "TypeError: lint" },
    ];
    const messages = (project({ action: "list", tasks }, "list")?.issues ?? []).map(
      (issue) => issue.message,
    );
    expect(messages).toHaveLength(2);
    expect(messages[0]?.startsWith("BuildError")).toBe(true);
    expect(messages[1]?.startsWith("TypeError: lint")).toBe(true);
  });

  it("explains a capped wait only in expanded detail", () => {
    const issueFor = (waitSeconds: number) =>
      find(
        project(wait("timeout", snapshot), "wait", "settled", false, {
          until: "exit",
          waitSeconds,
        }),
        "task-1:wait-timeout",
      );
    const capped = issueFor(120);
    const exact = issueFor(30);
    expect(capped?.message).toBe(exact?.message);
    expect(capped?.detail).toContain("120");
    expect(exact?.detail).not.toContain("120");
  });

  it("names the task whose logs were read", () => {
    const named = { ...logs("running"), task: { name: "dev server", command: "pnpm dev" } };
    expect(project(named, "logs")?.subject).toBe("dev server");
    expect(project(logs("running"), "logs")?.subject).toBe(snapshot.command);
  });
});
