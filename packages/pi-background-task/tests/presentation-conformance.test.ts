import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../pi-code-previews/src/config/state.ts";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";

const settings = { ...codePreviewSettings };
afterEach(() => setCodePreviewSettings(settings));
// SAFETY: The fixture supplies the styling operations the tool uses.
const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const snapshot = {
  id: "task-1",
  command: "run",
  cwd: "/task-working-directory",
  pid: 87654,
  state: "running",
  startedAt: 1,
  logCursor: 10,
  droppedLogBytes: 0,
};
const cursors = { nextCursor: 10, earliestAvailableCursor: 0, droppedBytes: 0 };
const fixtures = [
  ...["start", "status", "stop"].map((action) => ({ action, snapshot })),
  ...["list", "stop_all"].map((action) => ({ action, tasks: [snapshot] })),
  { action: "clear", removed: 1 },
  { action: "logs", logs: { id: "task-1", state: "running", ...cursors } },
  { action: "wait", wait: { id: "task-1", outcome: "matched", snapshot, ...cursors } },
  {
    action: "status",
    snapshot: { ...snapshot, state: "failed", exitCode: 9, droppedLogBytes: 50 },
  },
  { action: "status", snapshot: { ...snapshot, state: "stopping" } },
  { action: "status", snapshot: { ...snapshot, state: "stopped", signal: "SIGTERM" } },
  { action: "status", snapshot: { ...snapshot, state: "timed_out" } },
  { action: "wait", wait: { id: "task-1", outcome: "timeout", snapshot, ...cursors } },
  { action: "logs", logs: { id: "task-1", state: "running", ...cursors, droppedBytes: 50 } },
];

it("renders the registered management actions and task states without parsing fetched text", () => {
  for (const mode of ["on", "off", "border"] as const)
    for (const style of ["compact", "preview"] as const) {
      setCodePreviewSettings({
        ...settings,
        toolCallBackground: mode,
        toolCallCollapsedStyle: style,
        toolCallTiming: false,
      });
      let registered: ToolDefinition | undefined;
      // SAFETY: Registration reads no other ExtensionAPI members.
      const pi = {
        registerTool: (tool: ToolDefinition) => {
          registered = tool;
        },
      } as ExtensionAPI;
      registerBackgroundTaskTool(pi, { run: () => Promise.reject(new Error("not executed")) });
      for (const details of [...fixtures, undefined, { malformed: true }]) {
        const action = details && "action" in details ? details.action : "status";
        const args = { action, id: "task-1" };
        const result = {
          content: [
            {
              type: "text" as const,
              text: "fetched-body-marker\nError warning words are just log content",
            },
          ],
          details,
        };
        const before = structuredClone(result);
        const harness = createToolPresentationHarness(registered!, { theme });
        harness.call(args, { executionStarted: false });
        for (const isError of [false, true])
          for (const expanded of [false, true, false]) {
            harness.call(args, { expanded, isPartial: false, isError });
            harness.result(result, { expanded, isError });
            harness.invalidate();
            const text = harness.render(300).join("\n");
            if (expanded) {
              expect(text).toContain("fetched-body-marker");
              if (details && "snapshot" in details) {
                expect(text).toContain(snapshot.cwd);
                expect(text).toContain(String(snapshot.pid));
              }
            } else if (style === "compact") {
              expect(text).not.toContain("fetched-body-marker");
              expect(text).not.toMatch(
                /afterCursor|inspect status before retrying|Request a smaller log slice/,
              );
              if (
                !isError &&
                details &&
                "snapshot" in details &&
                details.snapshot.state === "stopping"
              )
                expect(text).toMatch(/processes may still be running/);
            }
          }
        expect(result).toEqual(before);
      }
    }
});

it("renders each classified task warning once beside labeled raw output", () => {
  for (const mode of ["on", "off", "border"] as const) {
    setCodePreviewSettings({
      ...settings,
      toolCallBackground: mode,
      toolCallCollapsedStyle: "compact",
      toolCallTiming: false,
    });
    let registered: ToolDefinition | undefined;
    // SAFETY: Only registration is exercised; the runner must not execute.
    const pi = {
      registerTool: (tool: ToolDefinition) => {
        registered = tool;
      },
    } as ExtensionAPI;
    registerBackgroundTaskTool(pi, { run: () => Promise.reject(new Error("not executed")) });
    const result = {
      content: [{ type: "text" as const, text: "Original task result marker" }],
      details: {
        action: "status",
        snapshot: { ...snapshot, state: "failed", exitCode: 9, droppedLogBytes: 50 },
      },
    };
    const before = structuredClone(result);
    const harness = createToolPresentationHarness(registered!, { theme });
    for (const expanded of [false, true, false, true]) {
      harness.call({ action: "status", id: snapshot.id }, { expanded });
      harness.result(result, { expanded });
      const text = harness.render(240).join("\n");
      expect(
        text.split(
          expanded
            ? "50 log bytes discarded; discarded output cannot be recovered."
            : "Some task output was discarded and cannot be recovered.",
        ),
      ).toHaveLength(2);
      expect(
        text.split(expanded ? "Process exited with code 9." : "The task exited with code 9."),
      ).toHaveLength(2);
      if (expanded) {
        expect(text).toContain("Raw task result");
        expect(text).toContain("Original task result marker");
      } else expect(text).not.toContain("Original task result marker");
    }
    expect(result).toEqual(before);
  }
});

it("attributes same-named tasks' independent warnings by task ID", () => {
  for (const mode of ["on", "off", "border"] as const) {
    setCodePreviewSettings({
      ...settings,
      toolCallBackground: mode,
      toolCallCollapsedStyle: "compact",
      toolCallTiming: false,
    });
    let registered: ToolDefinition | undefined;
    // SAFETY: Only registration is exercised; the runner must not execute.
    const pi = {
      registerTool: (tool: ToolDefinition) => {
        registered = tool;
      },
    } as ExtensionAPI;
    registerBackgroundTaskTool(pi, { run: () => Promise.reject(new Error("not executed")) });
    const result = {
      content: [{ type: "text" as const, text: "Original task list marker" }],
      details: {
        action: "list",
        tasks: [
          { ...snapshot, id: "task-a", name: "worker", state: "stopping" },
          { ...snapshot, id: "task-b", name: "worker", state: "stopping" },
        ],
      },
    };
    const before = structuredClone(result);
    const harness = createToolPresentationHarness(registered!, { theme });
    for (const expanded of [false, true, false, true]) {
      harness.call({ action: "list" }, { expanded });
      harness.result(result, { expanded });
      const text = harness.render(240).join("\n");
      for (const id of ["task-a", "task-b"]) {
        const warning = expanded
          ? `${id}: Process-tree cleanup is not confirmed; inspect status before retrying work.`
          : `${id}: Some task processes may still be running.`;
        expect(text.split(warning)).toHaveLength(2);
      }
      if (expanded) expect(text).toContain("Raw task result");
      else expect(text).not.toContain("Original task list marker");
    }
    expect(result).toEqual(before);
  }
});

it("keeps successful command delivery distinct from failed task state and discarded logs", () => {
  const summary = projectBackgroundTaskCompactSummary({
    phase: "settled",
    args: { action: "status", id: "task-1" },
    isError: false,
    result: {
      details: {
        action: "status",
        snapshot: { ...snapshot, state: "failed", exitCode: 9, droppedLogBytes: 50 },
      },
    },
  });
  expect(summary?.outcome).toBe("error");
  expect(summary?.issues?.entries.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["task-1:exit-code", "task-1:log-loss"]),
  );
  expect(summary?.expandedResultOwnsIssues).toBeUndefined();
});
