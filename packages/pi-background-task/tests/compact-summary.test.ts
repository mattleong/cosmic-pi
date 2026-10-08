import { describe, expect, it } from "vitest";
import { resolveCompactSummary, type CompactIssue } from "pi-code-previews";
import { issueMessageStyleProblems } from "pi-code-previews/testing";
import { formatDuration } from "pi-cosmic-core";
import {
  backgroundTaskActionLabel,
  projectBackgroundTaskCompactSummary,
} from "../src/ui/compact-summary.ts";
import { taskStateLabel } from "../src/ui/task-state.ts";
import type { BackgroundTaskSnapshot } from "../src/task/model.ts";
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
const severities = (summary: Summary, severity: CompactIssue["severity"]) =>
  summary?.issues?.filter((issue) => issue.severity === severity).map((issue) => issue.code);

describe("background task compact semantics", () => {
  it("keeps independent task failures and cleanup gates in one issue list", () => {
    const summary = project(
      {
        action: "list",
        tasks: [
          { ...snapshot, id: "three", state: "stopping", droppedLogBytes: 8 },
          { ...snapshot, id: "one", state: "failed", exitCode: 2 },
          { ...snapshot, id: "two", state: "failed", exitCode: 2 },
        ],
      },
      "list",
    );
    expect(summary?.outcome).toBe("error");
    // The first counter counts every state; later ones are shorter fallbacks for narrow rows.
    for (const count of ["2 failed", "1 stopping"]) expect(summary?.counters?.[0]).toContain(count);
    expect(summary?.counters?.at(-1)).toMatch(/^3 tasks$/u);
    expect(project({ action: "list", tasks: [] }, "list")?.counters).toEqual(["0 tasks"]);
    expect(severities(summary, "error")).toEqual(["one:exit-code", "two:exit-code"]);
    expect(severities(summary, "warning")).toEqual(["three:cleanup-unconfirmed", "three:log-loss"]);
    // Failures lead, whatever the tasks' order.
    expect(summary?.issues?.[0]?.severity).toBe("error");
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
    const labelled = (pattern: RegExp) => messages.filter((message) => pattern.test(message));
    // An unnamed task goes by its command.
    expect(labelled(/^test: /u)).toHaveLength(1);
    expect(labelled(/^worker \(1\): /u)).toHaveLength(1);
    expect(labelled(/^worker \(2\): /u)).toHaveLength(1);
    expect(labelled(/^builder: /u)).toHaveLength(1);
    expect(messages.join("\n")).not.toMatch(/task-[a-e]/u);
    for (const message of messages) expect(message.length).toBeLessThan(120);
    // The unprefixed message and agent detail are unchanged by aggregation, with no task ID.
    const single = project({ action: "status", snapshot: { ...snapshot, state: "stopping" } });
    const worker = summary?.issues?.find((issue) => issue.message.startsWith("worker (1)"));
    expect(worker?.message).toContain(single?.issues?.[0]?.message);
    expect(worker?.detail).toBe(single?.issues?.[0]?.detail);
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
    // A one-line error the message restates, final period aside, keeps no duplicate detail.
    for (const error of ["Custom failure", "Custom failure."]) {
      const plain = project({
        action: "status",
        snapshot: { ...snapshot, state: "failed", error },
      });
      expect(plain?.issues?.[0]?.detail).toBeUndefined();
    }

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

  it("never makes a task ID the subject, and names the task once its result arrives", () => {
    for (const phase of ["pending", "running"] as const) {
      const summary = projectBackgroundTaskCompactSummary({
        phase,
        args: { action: "status", id: "task-1" },
        result: undefined,
        isError: false,
      });
      expect(summary?.action).toBe("status");
      expect(summary?.subject).not.toContain("task-1");
      expect(summary?.outcome).toBeUndefined();
      // A wait says what it awaits, which the arguments do name.
      const waiting = projectBackgroundTaskCompactSummary({
        phase,
        args: { action: "wait", id: "task-1", until: "output", contains: "ready in" },
        result: undefined,
        isError: false,
      });
      expect(waiting?.subject).toContain("ready in");
      expect(waiting?.subject).not.toContain("task-1");
    }
    const final = project({ action: "status", snapshot });
    expect(final?.action).toBe("status");
    // An unnamed task goes by its command, the same collapsed and expanded.
    expect(final?.subject).toBe(snapshot.command);
    expect(final?.compactSubject).toBeUndefined();
    expect(final?.outcome).toBe("success");
    expect(final?.metadata).toEqual([taskStateLabel("running")]);
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
  });

  it("labels an unknown action by its own text, never an inherited object property", () => {
    for (const action of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      // SAFETY: Persisted or foreign arguments can carry actions outside the declared union.
      expect(backgroundTaskActionLabel(action as BackgroundTaskToolInput["action"])).toBe(action);
    }
  });

  it("classifies a rejected call as an error the shell explains from its text", () => {
    const summary = projectBackgroundTaskCompactSummary({
      phase: "settled",
      args: { action: "start", command: "pnpm dev", cwd: "missing" },
      result: { details: {} },
      isError: true,
    });
    expect(summary?.outcome).toBe("error");
    expect(summary?.subject).toBe("pnpm dev");
    const error = "Couldn't find the working directory /project/missing";
    const resolved = resolveCompactSummary(summary, "settled", true, error);
    expect(resolved?.issues?.map((issue) => issue.message)).toEqual([error]);
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
    expect(result?.counters?.[0]).toBe("20 stopped");
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

  it("keeps a confirmed stop neutral, with one subject collapsed and expanded", () => {
    const result = project(
      {
        action: "stop",
        snapshot: {
          ...snapshot,
          name: "server",
          state: "stopped",
          signal: "SIGTERM",
          exitCode: null,
        },
      },
      "stop",
    );
    expect(result?.outcome).toBe("cancelled");
    expect(result?.subject).toBe("server");
    expect(result?.compactSubject).toBeUndefined();
    expect(result?.metadata).toEqual([taskStateLabel("stopped")]);
    // The stop's own signal is routine, not a cause.
    expect(result?.issues).toEqual([]);
  });

  it("explains a timed-out task by its time limit alone", () => {
    const result = project({
      action: "status",
      snapshot: {
        ...snapshot,
        state: "timed_out",
        startedAt: 1_000,
        endedAt: 31_000,
        exitCode: 143,
        signal: "SIGTERM",
      },
    });
    expect(result?.outcome).toBe("error");
    expect(result?.issues?.map((issue) => issue.code)).toEqual(["task-1:runtime-timeout"]);
    expect(result?.issues?.[0]?.message).toContain("30s");
  });

  it("reports a spawn failure's own message", () => {
    const result = project({
      action: "status",
      snapshot: { ...snapshot, state: "failed", error: "Couldn't start the process" },
    });
    expect(result?.outcome).toBe("error");
    expect(result?.issues?.map((issue) => issue.message)).toEqual(["Couldn't start the process"]);
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
      {
        ...wait(
          "timeout",
          { ...snapshot, droppedLogBytes: 3 },
          {
            earliestAvailableCursor: 4,
            droppedBytes: 3,
          },
        ),
        // The default maxWaitSeconds cap the service applied to the request below.
        appliedWaitSeconds: 30,
      },
      "wait",
      "settled",
      false,
      { until: "exit", waitSeconds: 90 },
    );
    expect(result?.outcome).toBe("warning");
    expect(result?.metadata).toHaveLength(1);
    expect(result?.metadata?.[0]).toContain(taskStateLabel("running"));
    // One loss line, with where retained output resumes for the agent.
    expect(result?.issues?.filter((issue) => issue.code === "task-1:log-loss")).toHaveLength(1);
    expect(find(result, "task-1:log-loss")?.message).toContain("3 bytes");
    expect(find(result, "task-1:log-loss")?.detail).toContain("cursor 4");
    const timeout = find(result, "task-1:wait-timeout");
    expect(timeout?.severity).toBe("warning");
    // A capped wait reports how long it lasted, not the time it requested.
    expect(timeout?.message).toContain(formatDuration(30_000));
    expect(timeout?.message).not.toContain(formatDuration(90_000));
    expect(find(result, "task-1:runtime-timeout")).toBeUndefined();

    // Details without the applied wait never fall back to the requested time.
    const older = project(wait("timeout"), "wait", "settled", false, {
      until: "exit",
      waitSeconds: 90,
    });
    expect(find(older, "task-1:wait-timeout")?.message).not.toContain(formatDuration(90_000));
  });

  it.each([
    { ...snapshot, state: "exited", exitCode: 0 },
    { ...snapshot, state: "failed", exitCode: 1 },
  ])("describes a completed wait by the task's state, as status does: %j", (ended) => {
    const result = project(wait("completed", ended), "wait");
    const status = project({ action: "status", snapshot: ended });
    expect(result?.metadata).toEqual(status?.metadata);
    expect(result?.outcome).toBe(status?.outcome);
  });

  it.each([snapshot, { ...snapshot, state: "exited", exitCode: 0 }])(
    "keeps output-match evidence even when the process exits: %j",
    (matchedSnapshot) => {
      const summary = project(wait("matched", matchedSnapshot), "wait");
      const status = project({ action: "status", snapshot: matchedSnapshot });
      expect(summary?.outcome).toBe("success");
      expect(summary?.metadata).toHaveLength(1);
      // The match is reported beside the task's state, not in place of it.
      expect(summary?.metadata?.[0]).not.toBe(status?.metadata?.[0]);
      expect(summary?.metadata?.[0]).toContain(status?.metadata?.[0]);
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
    // Recovery rides on the warnings' details rather than repeating them as info lines.
    expect(severities(result, "info")).toEqual([]);
    const lossDetail = find(result, "task-1:log-loss")?.detail;
    expect(lossDetail).toContain("cursor 4");
    expect(lossDetail).toContain("cursor 10");
    expect(find(result, "task-1:log-loss")?.message).toContain("3 bytes");
    expect(find(result, "task-1:slice-truncated")?.message).toMatch(/2 of 5/u);
    expect(find(result, "task-1:slice-truncated")?.detail).toContain("20 bytes of 50 bytes");
    expect(find(result, "task-1:slice-truncated")?.detail).toMatch(/afterCursor/u);
    for (const issue of result?.issues ?? []) {
      expect(issue.message).not.toMatch(/cursor|tailLines/iu);
      expect(issue.detail).not.toContain(issue.message);
    }
  });

  it("treats exited log retrieval as successful without inventing process exit evidence", () => {
    const result = project(logs("exited"), "logs");
    expect(result?.outcome).toBe("success");
    expect(result?.action).toBe("logs");
    expect(result?.metadata).toEqual([taskStateLabel("exited")]);
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
      // Where the failure details are is agent recovery on the error itself.
      expect(result?.issues?.[0]?.detail).toMatch(/status/u);
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

  it("says why a task failed from its cause span or its exit status", () => {
    // The cause lives in the result text; details only record where.
    const message = (fields: Partial<BackgroundTaskSnapshot>, cause?: string) => {
      const line = `task-1 failed — test${cause ? `\n  cause: ${cause}` : ""}`;
      const start = line.indexOf("cause: ") + "cause: ".length;
      return projectBackgroundTaskCompactSummary({
        phase: "settled",
        args: { action: "status" },
        result: {
          details: {
            action: "status",
            snapshot: { ...snapshot, state: "failed", ...fields },
            ...(cause && { causes: [{ id: "task-1", start, end: start + cause.length }] }),
          },
          text: line,
        },
        isError: false,
      })
        ?.issues?.map((issue) => issue.message)
        .join("\n");
    };
    expect(message({ exitCode: 1 }, "FAIL tests/a.test.ts")).toMatch(
      /code 1: FAIL tests\/a\.test\.ts$/u,
    );
    expect(message({ exitCode: 137 })).toMatch(/code 137: killed/u);
    expect(message({ exitCode: null, signal: "SIGSEGV" })).toMatch(/SIGSEGV: crashed/u);
    expect(message({}, "fatal: no such ref")).toMatch(/: fatal: no such ref$/u);
    // Results without spans, or with spans the text does not hold, keep the bare exit status.
    expect(message({ exitCode: 1 })).toMatch(/code 1$/u);
    expect(
      projectBackgroundTaskCompactSummary({
        phase: "settled",
        args: { action: "status" },
        result: {
          details: {
            action: "status",
            snapshot: { ...snapshot, state: "failed", exitCode: 1 },
            causes: [{ id: "task-1", start: 5, end: 500 }],
          },
          text: "short",
        },
        isError: false,
      })?.issues?.[0]?.message,
    ).toMatch(/code 1$/u);
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
