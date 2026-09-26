import { describe, expect, it } from "vitest";
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
const codes = (summary: ReturnType<typeof project>) => summary?.notices?.map((n) => n.code);

describe("background task compact semantics", () => {
  it("keeps independent task failures and cleanup gates in one issue collection", () => {
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
    expect(summary?.issues?.coverage).toBe("complete");
    expect(
      summary?.issues?.entries
        .filter((entry) => entry.severity === "error")
        .map((entry) => entry.code),
    ).toEqual(["one:exit-code", "two:exit-code"]);
    expect(
      summary?.issues?.entries.flatMap((entry) => entry.recovery).map((entry) => entry.code),
    ).toContain("three:cleanup-unconfirmed");
    const unknown = project({
      action: "status",
      snapshot: {
        ...snapshot,
        state: "failed",
        error: "Custom failure. Inspect external state before retry.",
      },
    });
    expect(unknown?.issues?.coverage).toBe("unknown");
    expect(JSON.stringify(unknown?.issues)).toContain("Inspect external state before retry.");
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
  });
  it.each([
    [{ state: "exited", exitCode: 2 }, "error", "exit-code"],
    [{ state: "exited", signal: "SIGKILL", exitCode: null }, "error", "signal"],
    [{ state: "timed_out" }, "error", "runtime-timeout"],
    [{ state: "failed" }, "error", "failed"],
    [{ state: "failed", exitCode: 0 }, "error", "failed"],
    [{ state: "stopping" }, "uncertain", "cleanup-unconfirmed"],
    [{ state: "exited" }, "uncertain", "exit-unknown"],
  ])("projects status causes outside clippable metadata: %j", (fields, outcome, cause) => {
    const result = project({ action: "status", snapshot: { ...snapshot, ...fields } });
    expect(result?.outcome).toBe(outcome);
    expect(result?.detailsOnExpand).toBe(true);
    expect(codes(result)).toContain(`task-1:${cause}`);
  });
  it("keeps a confirmed stop signal neutral and visible without metadata", () => {
    const result = project(
      {
        action: "stop",
        snapshot: { ...snapshot, state: "stopped", signal: "SIGTERM", exitCode: null },
      },
      "stop",
    );
    expect(result?.outcome).toBe("cancelled");
    expect(result?.detailsOnExpand).toBe(true);
    expect(result?.subject).toContain("SIGTERM");
    expect(result?.notices?.some((notice) => notice.kind === "error")).toBe(false);
  });
  it("keeps unconfirmed cleanup and full failure guidance visible", () => {
    const error = "Termination failed. Inspect the process tree before retrying.";
    const result = project({
      action: "status",
      snapshot: { ...snapshot, state: "stopping", error },
    });
    expect(result?.outcome).toBe("error");
    expect(result?.notices?.some((n) => n.text.includes(error))).toBe(true);
    expect(result?.notices?.some((n) => n.kind === "recovery")).toBe(true);
    expect(result?.failure).toBeUndefined();
  });
  it("reports wait timeout without claiming task timeout or completion", () => {
    const result = project(
      wait("timeout", snapshot, { earliestAvailableCursor: 4, droppedBytes: 3 }),
      "wait",
    );
    expect(result?.outcome).toBe("warning");
    expect(result?.metadata).toHaveLength(1);
    expect(result?.metadata?.join(" ")).toMatch(/timeout.*running/);
    expect(result?.notices?.some((n) => n.text.includes("3 log bytes"))).toBe(true);
    expect(codes(result)).toContain("task-1:wait-timeout");
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

  it("preserves dropped output and truncation recovery", () => {
    const result = project(
      logs("running", { earliestAvailableCursor: 4, droppedBytes: 3 }, true),
      "logs",
    );
    expect(result?.outcome).toBe("warning");
    expect(result?.detailsOnExpand).toBe(true);
    expect(
      result?.notices?.some(
        (n) => n.text.includes("earliest cursor 4") && n.text.includes("next cursor 10"),
      ),
    ).toBe(true);
    expect(result?.notices?.some((n) => n.text.includes("3 log bytes"))).toBe(true);
    expect(result?.notices?.some((n) => n.text.includes("20/50"))).toBe(true);
  });
  it("treats exited log retrieval as successful without inventing process exit evidence", () => {
    const result = project(logs("exited"), "logs");
    expect(result?.outcome).toBe("success");
    expect(result?.action).toBe("logs");
    expect(result?.metadata).toEqual(["exited"]);
    expect(result?.detailsOnExpand).toBe(true);
    expect(result?.notices).toEqual([]);
  });
  it.each([
    ["failed", "error"],
    ["timed_out", "error"],
    ["stopped", "cancelled"],
    ["stopping", "uncertain"],
  ])("retains actual log-state attention for %s", (state, outcome) => {
    const result = project(logs(state), "logs");
    expect(result?.outcome).toBe(outcome);
    if (outcome === "error")
      expect(result?.notices?.some((notice) => notice.kind === "error")).toBe(true);
    if (state === "stopping") expect(codes(result)).toContain("task-1:cleanup-unconfirmed");
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
    expect(result?.notices?.some((notice) => notice.kind === "warning")).toBe(true);
    expect(result?.notices?.some((notice) => notice.text.includes("exit code"))).toBe(false);
  });
});
