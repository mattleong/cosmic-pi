import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { describe, expect, it } from "vitest";
import type { CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../src/task/bounds.ts";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

type Input = Parameters<typeof projectBackgroundTaskCompactSummary>[0];
const snapshot = {
  id: "task-0000000001",
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
  Option.getOrUndefined(Arr.findFirst(summary?.issues ?? [], (issue) => issue.code === code));

describe("background task compact semantics", () => {
  it("bounds the call subject of a maximum-size command to the display limit", () => {
    const command = Fn.pipe("x", Str.repeat(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes));
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
    expect(find(result, `task-0000000001:${code}`)?.severity).toBe(severity);
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
      ...Arr.map(snapshots, (value) => project({ action: "status", snapshot: value })),
      project(
        {
          action: "list",
          tasks: Arr.map(snapshots, (value, index) => ({
            ...value,
            id: `task-${Fn.pipe(`${index}`, Str.padStart(10, "0"))}`,
          })),
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
    const issues = Arr.flatMap(summaries, (summary) => summary?.issues ?? []);
    expect(issues.length).toBeGreaterThan(snapshots.length);
    for (const { message } of issues)
      expect({
        message,
        problems: issueMessageStyleProblems(message, { forbidden: ["task-0000000001"] }),
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
    const metadata = summary?.metadata;
    expect(metadata && Arr.join(metadata, " ")).toContain("failed");
  });

  it("renders the failure cause stored in details", () => {
    const failureCause = "FAIL tests/auth.test.ts > adds";
    const summary = project({ action: "status", snapshot: { ...failed, failureCause } });
    expect(find(summary, "task-0000000001:exit-code")?.message).toContain(failureCause);
  });

  it("keeps each task's label in aggregate issues, even for error-like names", () => {
    const tasks = [
      { ...failed, id: "task-0000000001", name: "BuildError" },
      { ...failed, id: "task-0000000002", name: "TypeError: lint" },
    ];
    const messages = Arr.map(
      project({ action: "list", tasks }, "list")?.issues ?? [],
      (issue) => issue.message,
    );
    expect(messages).toHaveLength(2);
    const [first, second] = messages;
    expect(first && Fn.pipe(first, Str.startsWith("BuildError"))).toBe(true);
    expect(second && Fn.pipe(second, Str.startsWith("TypeError: lint"))).toBe(true);
  });

  it("explains a capped wait only in expanded detail", () => {
    const issueFor = (waitSeconds: number) =>
      find(
        project(wait("timeout", snapshot), "wait", "settled", false, {
          until: "exit",
          waitSeconds,
        }),
        "task-0000000001:wait-timeout",
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
