import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setCodePreviewSettings } from "../../pi-code-previews/src/config/state.ts";
import { defaultCodePreviewSettings } from "../../pi-code-previews/src/config/defaults.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { describe, expect, it } from "vitest";
import { backgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";
import type { BackgroundTaskToolInput } from "../src/tools/schema.ts";

type Input = Parameters<typeof backgroundTaskCompactSummary>[0];
const snapshot = {
  id: "task-1",
  command: "test",
  cwd: "/tmp",
  state: "running",
  startedAt: 1,
  logCursor: 10,
  droppedLogBytes: 0,
};
const project = <Details>(
  details: Details,
  action: BackgroundTaskToolInput["action"] = "status",
  phase: Input["phase"] = "settled",
  isError = false,
) =>
  backgroundTaskCompactSummary({
    phase,
    args: { action },
    result: { details, content: [{ type: "text", text: "ordinary output" }] },
    context: {
      args: { action },
      state: {},
      lastComponent: undefined,
      toolCallId: "call",
      cwd: "/tmp",
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError,
      invalidate() {},
    },
  });

describe("background task compact semantics", () => {
  it("retains supplied task identity before a status result arrives", () => {
    for (const phase of ["pending", "running"] as const) {
      const summary = backgroundTaskCompactSummary({
        phase,
        args: { action: "status", id: "task-1" },
        result: undefined,
        // SAFETY: The provider only reads isError from this render context.
        context: { isError: false } as Input["context"],
      });
      expect(summary?.action).toBe("status");
      expect(summary?.subject).toBe("task-1");
    }
    const final = project({ action: "status", snapshot });
    expect(final?.action).toBe("status");
    expect(final?.subject).toBe("task-1");
  });

  it("prefers a task name and uses the command only before start settles", () => {
    for (const name of [undefined, "Build checks"]) {
      const summary = backgroundTaskCompactSummary({
        phase: "running",
        args: { action: "start", command: "pnpm test", ...(name && { name }) },
        result: undefined,
        // SAFETY: The provider only reads isError from this render context.
        context: { isError: false } as Input["context"],
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
  it("distinguishes unfinished management calls from a running background process", () => {
    expect(project(undefined, "status", "pending")?.outcome).toBeUndefined();
    expect(project(undefined, "status", "running")?.outcome).toBeUndefined();
    const result = project({ action: "status", snapshot });
    expect(result?.outcome).toBe("success");
    expect(result?.metadata).toEqual(["running"]);
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
  it("does not trust outer success when a process failed, timed out or was stopped", () => {
    expect(
      project({ action: "status", snapshot: { ...snapshot, state: "exited", exitCode: 2 } })
        ?.outcome,
    ).toBe("error");
    expect(
      project({ action: "status", snapshot: { ...snapshot, state: "timed_out" } })?.outcome,
    ).toBe("error");
    expect(
      project(
        {
          action: "stop",
          snapshot: { ...snapshot, state: "stopped", signal: "SIGTERM", exitCode: null },
        },
        "stop",
      )?.outcome,
    ).toBe("cancelled");
    expect(project({ action: "status", snapshot: { ...snapshot, state: "exited" } })?.outcome).toBe(
      "uncertain",
    );
  });
  it.each([
    [{ state: "exited", exitCode: 2 }, "error", "code 2"],
    [{ state: "exited", signal: "SIGKILL", exitCode: null }, "error", "SIGKILL"],
    [{ state: "timed_out" }, "error", "timeout"],
    [{ state: "failed" }, "error", "failed"],
    [{ state: "failed", exitCode: 0 }, "error", "failed"],
    [{ state: "stopping" }, "uncertain", "not confirmed"],
    [{ state: "exited" }, "uncertain", "exit code is unknown"],
  ])("projects status causes outside clippable metadata: %j", (fields, outcome, cause) => {
    const result = project({ action: "status", snapshot: { ...snapshot, ...fields } });
    expect(result?.outcome).toBe(outcome);
    expect(result?.detailsOnExpand).toBe(true);
    expect(result?.notices?.some((notice) => notice.text.includes(cause))).toBe(true);
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
      {
        action: "wait",
        wait: {
          id: snapshot.id,
          snapshot,
          outcome: "timeout",
          nextCursor: 10,
          earliestAvailableCursor: 4,
          droppedBytes: 3,
        },
      },
      "wait",
    );
    expect(result?.outcome).toBe("warning");
    expect(result?.metadata).toHaveLength(1);
    expect(result?.metadata?.join(" ")).toMatch(/timeout.*running/);
    expect(result?.notices?.some((n) => n.text.includes("3 log bytes"))).toBe(true);
    expect(result?.notices?.some((n) => n.text.includes("does not stop"))).toBe(true);
  });
  it("keeps completed waits distinct from process exit state", () => {
    const result = project(
      {
        action: "wait",
        wait: {
          id: snapshot.id,
          snapshot: { ...snapshot, state: "exited", exitCode: 0 },
          outcome: "completed",
          nextCursor: 10,
          earliestAvailableCursor: 0,
          droppedBytes: 0,
        },
      },
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
      const details = {
        action: "wait",
        wait: {
          id: snapshot.id,
          snapshot: matchedSnapshot,
          outcome: "matched",
          nextCursor: 10,
          earliestAvailableCursor: 0,
          droppedBytes: 0,
        },
      };
      const summary = project(details, "wait");
      expect(summary?.outcome).toBe("success");
      expect(summary?.metadata).toHaveLength(1);
      expect(summary?.metadata?.join(" ")).toContain("matched");
      if (matchedSnapshot.state === "running")
        expect(summary?.metadata?.join(" ")).not.toContain("exit");
      else expect(summary?.metadata?.join(" ")).toContain("exit 0");
      expect(
        project({ ...details, wait: { ...details.wait, id: "other" } }, "wait"),
      ).toBeUndefined();
    },
  );

  it("preserves dropped output and truncation recovery without copying logs", () => {
    const result = project(
      {
        action: "logs",
        logs: {
          id: "task-1",
          state: "running",
          nextCursor: 10,
          earliestAvailableCursor: 4,
          droppedBytes: 3,
        },
        truncation: {
          truncated: true,
          outputBytes: 20,
          totalBytes: 50,
          outputLines: 2,
          totalLines: 5,
        },
      },
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
    expect(JSON.stringify(result)).not.toContain("ordinary output");
  });
  it("treats exited log retrieval as successful without inventing process exit evidence", () => {
    const result = project(
      {
        action: "logs",
        logs: {
          id: "task-1",
          state: "exited",
          nextCursor: 10,
          earliestAvailableCursor: 0,
          droppedBytes: 0,
        },
      },
      "logs",
    );
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
    const result = project(
      {
        action: "logs",
        logs: {
          id: "task-1",
          state,
          nextCursor: 10,
          earliestAvailableCursor: 0,
          droppedBytes: 0,
        },
      },
      "logs",
    );
    expect(result?.outcome).toBe(outcome);
    if (outcome === "error")
      expect(result?.notices?.some((notice) => notice.kind === "error")).toBe(true);
    if (state === "stopping")
      expect(result?.notices?.some((notice) => notice.text.includes("not confirmed"))).toBe(true);
  });
  it.each(["dropped", "truncated"])("keeps %s exited logs as attention", (loss) => {
    const result = project(
      {
        action: "logs",
        logs: {
          id: "task-1",
          state: "exited",
          nextCursor: 10,
          earliestAvailableCursor: 4,
          droppedBytes: loss === "dropped" ? 3 : 0,
        },
        truncation: {
          truncated: loss === "truncated",
          outputBytes: 20,
          totalBytes: loss === "truncated" ? 50 : 20,
          outputLines: 2,
          totalLines: loss === "truncated" ? 5 : 2,
        },
      },
      "logs",
    );
    expect(result?.outcome).toBe("warning");
    expect(result?.notices?.some((notice) => notice.kind === "warning")).toBe(true);
    expect(result?.notices?.some((notice) => notice.text.includes("exit code"))).toBe(false);
  });
  it("aggregates actual task states and retains individual failure information", () => {
    const result = project(
      {
        action: "list",
        tasks: [snapshot, { ...snapshot, id: "task-2", state: "failed", exitCode: 3 }],
      },
      "list",
    );
    expect(result?.outcome).toBe("error");
    expect(result?.counters).toHaveLength(1);
    expect(result?.counters?.join(" ")).toContain("1 running");
    expect(result?.counters?.join(" ")).toContain("1 failed");
    expect(
      result?.notices?.some(
        (n) => n.kind === "error" && n.text.includes("task-2") && n.text.includes("3"),
      ),
    ).toBe(true);
  });
});

// SAFETY: Only the declared rendering and registration capabilities are used by this test.
const animationFixture = <Value>(value: Value): never => value as never;
interface AnimationCallback {
  tick: (() => void) | undefined;
}

it.each([
  {
    action: "logs",
    logs: {
      id: snapshot.id,
      state: "exited",
      nextCursor: 10,
      earliestAvailableCursor: 0,
      droppedBytes: 0,
    },
  },
  {
    action: "logs",
    logs: {
      id: snapshot.id,
      state: "failed",
      nextCursor: 10,
      earliestAvailableCursor: 0,
      droppedBytes: 0,
    },
  },
  {
    action: "stop",
    snapshot: { ...snapshot, state: "stopped", signal: "SIGTERM", exitCode: null },
  },
  { action: "status", snapshot: { ...snapshot, state: "exited", exitCode: 2 } },
  { action: "status", snapshot: { ...snapshot, state: "stopping" } },
])("keeps ordinary bodies expansion-only without changing inputs: %j", (details) => {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
  });
  try {
    const tools: ToolDefinition[] = [];
    registerBackgroundTaskTool(
      animationFixture({
        registerTool: (tool: ToolDefinition) => tools.push(tool),
      }),
      { run: () => Promise.reject(new Error("rendering must not execute")) },
    );
    const tool = tools[0]!;
    const args = Object.freeze({ action: details.action, id: snapshot.id });
    const result = {
      content: [{ type: "text" as const, text: "ordinary private log body" }],
      details,
    };
    const before = structuredClone(result);
    const theme = animationFixture({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    const context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] = animationFixture({
      args,
      state: {},
      toolCallId: "call",
      cwd: "/tmp",
      expanded: false,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      isError: false,
      invalidate() {},
    });
    const call = tool.renderCall!(args, theme, context);
    const collapsed = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme,
      context,
    );
    expect([...call.render(100), ...collapsed.render(100)].join("\n")).not.toContain(
      "ordinary private log body",
    );
    const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {
      ...context,
      expanded: true,
    });
    expect([...call.render(100), ...expanded.render(100)].join("\n")).toContain(
      "ordinary private log body",
    );
    expect(result).toEqual(before);
    expect(args).toEqual({ action: details.action, id: snapshot.id });
  } finally {
    setCodePreviewSettings(defaultCodePreviewSettings);
  }
});

it("uses the registering owner's scheduler and releases it when the call settles", () => {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
  });
  try {
    const tools: ToolDefinition[] = [];
    const pi: ExtensionAPI = animationFixture({
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerMessageRenderer() {},
    });
    const unavailable = () => Promise.reject(new Error("not executed"));
    const animation: AnimationCallback = { tick: undefined };
    let stopped = 0;
    const scheduleAnimation = (_interval: number, callback: () => void) => {
      animation.tick = callback;
      return () => {
        stopped++;
      };
    };
    registerBackgroundTaskTool(pi, { run: unavailable, scheduleAnimation });
    const theme = animationFixture({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    for (const tool of tools) {
      let invalidated = 0;
      const args = { action: "wait", id: "task-1" };
      const context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] = animationFixture({
        args,
        state: {},
        toolCallId: tool.name,
        cwd: "/tmp",
        expanded: false,
        executionStarted: true,
        argsComplete: true,
        isPartial: true,
        isError: false,
        invalidate: () => {
          invalidated++;
        },
      });
      tool.renderCall?.(args, theme, context).render(100);
      expect(animation.tick).toBeTypeOf("function");
      animation.tick?.();
      expect(invalidated).toBeGreaterThan(0);
      const before = stopped;
      tool
        .renderResult?.(
          { content: [{ type: "text", text: "done" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { ...context, isPartial: false },
        )
        .render(100);
      expect(stopped).toBeGreaterThan(before);
    }
  } finally {
    setCodePreviewSettings(defaultCodePreviewSettings);
  }
});
