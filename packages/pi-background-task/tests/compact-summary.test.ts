import { describe, expect, it } from "vitest";
import type { CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import type { BackgroundTaskDetailsSnapshot } from "../src/task/model.ts";
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
const project = <Details>(
  details: Details,
  action: BackgroundTaskToolInput["action"] = "status",
  phase: Input["phase"] = "settled",
  isError = false,
) => projectBackgroundTaskCompactSummary({ phase, args: { action }, result: { details }, isError });
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
const severities = (summary: Summary, severity: CompactIssue["severity"]) =>
  summary?.issues?.filter((issue) => issue.severity === severity).map((issue) => issue.code);

describe("background task compact semantics", () => {
  it("keeps independent task failures and cleanup gates in one issue list", () => {
    const summary = project(
      {
        action: "list",
        tasks: [
          { ...snapshot, id: "one", state: "exited", exitCode: 2 },
          { ...snapshot, id: "two", state: "exited", exitCode: 2 },
          { ...snapshot, id: "three", state: "stopping", droppedLogBytes: 8 },
        ],
      },
      "list",
    );
    expect(summary?.outcome).toBe("error");
    expect(summary?.counters).toHaveLength(1);
    for (const count of ["2 exited", "1 stopping"]) expect(summary?.counters?.[0]).toContain(count);
    expect(severities(summary, "error")).toEqual(["one:exit-code", "two:exit-code"]);
    expect(severities(summary, "warning")).toEqual(["three:log-loss", "three:cleanup-unconfirmed"]);
  });

  it("names each task in aggregate messages without IDs, numbering shared names", () => {
    const summary = project(
      {
        action: "stop_all",
        tasks: [
          { ...snapshot, id: "task-a", name: "worker", state: "stopping" },
          { ...snapshot, id: "task-b", name: "worker", state: "stopping" },
          { ...snapshot, id: "task-c", name: "builder", state: "exited", exitCode: 1 },
          { ...snapshot, id: "task-d", name: "n".repeat(256), state: "exited", exitCode: 1 },
          { ...snapshot, id: "task-e", state: "exited", exitCode: 2 },
        ],
      },
      "stop_all",
    );
    const messages = summary?.issues?.map((issue) => issue.message) ?? [];
    expect(messages).toHaveLength(5);
    expect(messages[4]).toMatch(/^Task 5: /);
    expect(messages[0]).toMatch(/^worker \(1\): /);
    expect(messages[1]).toMatch(/^worker \(2\): /);
    expect(messages[2]).toMatch(/^builder: /);
    expect(messages.join("\n")).not.toMatch(/task-[a-e]/u);
    expect(messages[3]!.length).toBeLessThan(120);
    // The unprefixed message and agent detail are unchanged by aggregation.
    const single = project({ action: "status", snapshot: { ...snapshot, state: "stopping" } });
    expect(messages[0]).toContain(single?.issues?.[0]?.message);
    // The agent-facing detail names the exact task, then keeps the original detail.
    expect(summary?.issues?.[0]?.detail).toBe(`Task task-a\n${single?.issues?.[0]?.detail}`);
  });

  it("keeps unclassified task errors visible, with full text as expanded detail", () => {
    const single = project({
      action: "status",
      snapshot: { ...snapshot, state: "failed", error: "Custom failure. Inspect state." },
    });
    expect(single?.outcome).toBe("error");
    // Trailing guidance is agent detail: the message keeps the failure, the detail the full text.
    expect(single?.issues).toEqual([
      expect.objectContaining({ severity: "error", message: "Custom failure" }),
    ]);
    expect(single?.issues?.[0]?.detail).toBe("Custom failure. Inspect state.");
    const plain = project({
      action: "status",
      snapshot: { ...snapshot, state: "failed", error: "Custom failure" },
    });
    expect(plain?.issues?.[0]?.detail).toBeUndefined();

    const error = "\u001b[31mSpawn failed\u001b[0m\nENOENT: no such file\n  at spawn";
    const multi = project({ action: "status", snapshot: { ...snapshot, state: "failed", error } });
    const issue = multi?.issues?.[0];
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toBe("Spawn failed");
    expect(issue?.detail).toContain("ENOENT: no such file\n  at spawn");
    expect(JSON.stringify(multi)).not.toContain("\u001b");

    const long = project({
      action: "status",
      snapshot: { ...snapshot, state: "failed", error: "x".repeat(2048) },
    });
    expect(long?.issues?.[0]?.message.length).toBeLessThan(2048);
    expect(long?.issues?.[0]?.detail).toBe("x".repeat(2048));
  });

  it("retains supplied task identity before a status result arrives", () => {
    for (const phase of ["pending", "running"] as const) {
      const summary = projectBackgroundTaskCompactSummary({
        phase,
        args: { action: "status", id: "task-1" },
        result: undefined,
        isError: false,
      });
      expect(summary?.action).toBe("status");
      expect(summary?.subject).toBe("task-1");
      expect(summary?.outcome).toBeUndefined();
    }
    const final = project({ action: "status", snapshot });
    expect(final?.action).toBe("status");
    expect(final?.subject).toBe("task-1");
    expect(final?.outcome).toBe("success");
    expect(final?.metadata).toEqual(["running"]);
    expect(final?.issues).toEqual([]);
  });

  it("prefers a task name and uses the command only before start settles", () => {
    for (const name of [undefined, "Build checks"]) {
      const summary = projectBackgroundTaskCompactSummary({
        phase: "running",
        args: { action: "start", command: "pnpm test", ...(name && { name }) },
        result: undefined,
        isError: false,
      });
      expect(summary?.subject).toBe(name ?? "pnpm test");
      expect(summary?.outcome).toBeUndefined();
    }
    const named = project({ action: "status", snapshot: { ...snapshot, name: "Build checks" } });
    expect(named?.subject).toBe("Build checks");
    expect(JSON.stringify(named)).not.toMatch(/task-1|\/tmp|logCursor/);
    expect(project({ action: "status", snapshot: { ...snapshot, name: 42 } })).toBeUndefined();
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
    expect(project({ action: "status", snapshot }, "status", "settled", true)).toBeUndefined();
  });

  it("keeps aggregate stopped summaries bounded without repeating every task ID", () => {
    const result = project(
      {
        action: "list",
        tasks: Array.from({ length: 20 }, (_, index) => ({
          ...snapshot,
          id: `cancelled-${index}`,
          state: "stopped",
        })),
      },
      "list",
    );
    expect(result?.outcome).toBe("cancelled");
    expect(result?.counters).toEqual(["20 stopped"]);
    expect(result?.subject).not.toContain("cancelled-");
    expect(result?.issues).toEqual([]);
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

  it("keeps a confirmed stop signal neutral and visible in the subject", () => {
    const result = project(
      {
        action: "stop",
        snapshot: { ...snapshot, state: "stopped", signal: "SIGTERM", exitCode: null },
      },
      "stop",
    );
    expect(result?.outcome).toBe("cancelled");
    expect(result?.subject).toContain("SIGTERM");
    expect(result?.issues).toEqual([]);
  });

  it("keeps unconfirmed cleanup attention beside a reported failure", () => {
    const error = "Termination failed. Inspect the process tree before retrying.";
    const result = project({
      action: "status",
      snapshot: { ...snapshot, state: "stopping", error },
    });
    expect(result?.outcome).toBe("error");
    expect(find(result, "task-1:cleanup-unconfirmed")?.severity).toBe("warning");
    expect(find(result, "task-1:cleanup-unconfirmed")?.detail).toBeTruthy();
    expect(
      result?.issues?.some(
        (issue) => issue.message === "Termination failed" && issue.detail === error,
      ),
    ).toBe(true);
  });

  it("reports wait timeout without claiming task timeout or completion", () => {
    const result = project(
      wait("timeout", snapshot, { earliestAvailableCursor: 4, droppedBytes: 3 }),
      "wait",
    );
    expect(result?.outcome).toBe("warning");
    expect(result?.metadata).toHaveLength(1);
    expect(result?.metadata?.join(" ")).toMatch(/timeout.*running/);
    expect(find(result, "task-1:log-loss")?.detail).toContain("3 log bytes");
    expect(find(result, "task-1:wait-timeout")?.severity).toBe("warning");
    expect(find(result, "task-1:retained-cursors")?.severity).toBe("info");
    expect(find(result, "task-1:runtime-timeout")).toBeUndefined();
  });

  it("keeps completed waits distinct from process exit state", () => {
    const result = project(
      wait("completed", { ...snapshot, state: "exited", exitCode: 0 }),
      "wait",
    );
    expect(result?.metadata).toHaveLength(1);
    expect(result?.outcome).toBe("success");
    expect(result?.metadata?.join(" ")).toContain("exit 0");
    expect(project({ action: "list", tasks: [] }, "list")?.counters).toEqual(["0 tasks"]);
  });

  it.each([snapshot, { ...snapshot, state: "exited", exitCode: 0 }])(
    "keeps output-match evidence even when the process exits: %j",
    (matchedSnapshot) => {
      const summary = project(wait("matched", matchedSnapshot), "wait");
      expect(summary?.outcome).toBe("success");
      expect(summary?.metadata).toHaveLength(1);
      expect(summary?.metadata?.join(" ")).toContain("matched");
      if (matchedSnapshot.state === "running")
        expect(summary?.metadata?.join(" ")).not.toContain("exit");
      else expect(summary?.metadata?.join(" ")).toContain("exit 0");
      expect(project(wait("matched", matchedSnapshot, { id: "other" }), "wait")).toBeUndefined();
    },
  );

  it("keeps agent recovery for dropped and truncated logs out of human messages", () => {
    const result = project(
      logs("running", { earliestAvailableCursor: 4, droppedBytes: 3 }, true),
      "logs",
    );
    expect(result?.outcome).toBe("warning");
    expect(severities(result, "warning")).toEqual(["task-1:log-loss", "task-1:slice-truncated"]);
    expect(severities(result, "info")).toEqual([
      "task-1:retained-cursors",
      "task-1:request-log-slice",
    ]);
    const cursorsDetail = find(result, "task-1:retained-cursors")?.detail;
    expect(cursorsDetail).toContain("earliest cursor 4");
    expect(cursorsDetail).toContain("next cursor 10");
    expect(find(result, "task-1:log-loss")?.detail).toContain("3 log bytes");
    expect(find(result, "task-1:slice-truncated")?.detail).toContain("20/50");
    for (const issue of result?.issues ?? []) expect(issue.message).not.toMatch(/cursor|\d/);
  });

  it("treats exited log retrieval as successful without inventing process exit evidence", () => {
    const result = project(logs("exited"), "logs");
    expect(result?.outcome).toBe("success");
    expect(result?.action).toBe("logs");
    expect(result?.metadata).toEqual(["exited"]);
    expect(result?.issues).toEqual([]);
  });

  it.each([
    ["failed", "error"],
    ["timed_out", "error"],
    ["stopped", "cancelled"],
    ["stopping", "uncertain"],
  ])("retains actual log-state attention for %s", (state, outcome) => {
    const result = project(logs(state), "logs");
    expect(result?.outcome).toBe(outcome);
    if (outcome === "error") {
      expect(severities(result, "error")).toHaveLength(1);
      expect(find(result, "task-1:read-task-status")?.severity).toBe("info");
    }
    if (state === "stopping")
      expect(find(result, "task-1:cleanup-unconfirmed")?.severity).toBe("warning");
    if (state === "stopped") expect(result?.issues).toEqual([]);
  });

  it.each(["dropped", "truncated"])("keeps %s exited logs as attention", (loss) => {
    const result = project(
      logs(
        "exited",
        { earliestAvailableCursor: 4, droppedBytes: loss === "dropped" ? 3 : 0 },
        loss === "truncated",
      ),
      "logs",
    );
    expect(result?.outcome).toBe("warning");
    expect(severities(result, "warning")).toHaveLength(1);
    expect(result?.issues?.some((issue) => issue.code.endsWith("exit-code"))).toBe(false);
  });

  it("says why a task failed from its captured line or its exit status", () => {
    const message = (fields: Partial<BackgroundTaskDetailsSnapshot>) =>
      project({ action: "status", snapshot: { ...snapshot, state: "failed", ...fields } })
        ?.issues?.map((issue) => issue.message)
        .join("\n");
    expect(message({ exitCode: 1, failureLine: "FAIL tests/a.test.ts" })).toBe(
      "The task exited with code 1: FAIL tests/a.test.ts",
    );
    expect(message({ exitCode: 137 })).toMatch(/code 137: killed/u);
    expect(message({ exitCode: null, signal: "SIGSEGV" })).toMatch(/SIGSEGV: crashed/u);
    expect(message({ failureLine: "fatal: no such ref" })).toBe(
      "The task failed: fatal: no such ref",
    );
    // Results written before the field existed keep the bare exit status.
    expect(message({ exitCode: 1 })).toBe("The task exited with code 1");
    // An oversized line fails the details bound, leaving the generic row.
    expect(
      project({
        action: "status",
        snapshot: { ...snapshot, state: "failed", exitCode: 1, failureLine: "x".repeat(65) },
      }),
    ).toBeUndefined();
  });

  it("writes every issue message in the shared style, without task IDs", () => {
    const snapshots = [
      { ...snapshot, state: "failed", error: "Error: spawn ENOENT\n  at spawn" },
      { ...snapshot, state: "failed" },
      { ...snapshot, state: "exited", exitCode: 2 },
      { ...snapshot, state: "failed", exitCode: 1, failureLine: "FAIL tests/a.test.ts > adds" },
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
