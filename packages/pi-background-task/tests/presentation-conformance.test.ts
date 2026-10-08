import { afterEach, expect, it } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  probeAnimationOwnership,
} from "pi-code-previews/testing";
import type { CompactAnimationScheduler } from "pi-code-previews";
import { registerBackgroundTaskTool } from "../src/tools/background-task.ts";
import { projectBackgroundTaskCompactSummary } from "../src/ui/compact-summary.ts";

const restoreSettings = applyPresentationSettings({});
afterEach(restoreSettings);
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
  { action: "logs", logs: { id: "task-1", state: "exited", ...cursors } },
  { action: "logs", logs: { id: "task-1", state: "failed", ...cursors } },
  { action: "status", snapshot: { ...snapshot, state: "exited", exitCode: 2 } },
];
const registeredTool = (
  mode: "on" | "off" | "border",
  style: "compact" | "preview" = "compact",
  scheduleAnimation?: CompactAnimationScheduler,
) => {
  applyPresentationSettings({
    toolCallBackground: mode,
    toolCallCollapsedStyle: style,
    toolCallTiming: false,
  });
  const run = () => Promise.reject(new Error("not executed"));
  return captureRegistrations((pi) =>
    registerBackgroundTaskTool(pi, { run, ...(scheduleAnimation && { scheduleAnimation }) }),
  ).tools[0]!;
};

it("renders the registered management actions and task states without parsing fetched text", () => {
  for (const mode of ["on", "off", "border"] as const)
    for (const style of ["compact", "preview"] as const) {
      const tool = registeredTool(mode, style);
      for (const details of [...fixtures, undefined, { malformed: true }]) {
        const action = details && "action" in details ? details.action : "status";
        const args = Object.freeze({ action, id: "task-1" });
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
        const harness = createToolPresentationHarness(tool);
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
              // A Pi error explains itself with its first line; the body stays collapsed.
              if (!isError) expect(text).not.toContain("fetched-body-marker");
              expect(text).not.toContain("just log content");
            }
          }
        expect(result).toEqual(before);
      }
    }
});

const occurrences = (text: string, part: string) => text.split(part).length - 1;

it.each([
  [
    "renders each classified task issue once beside labeled raw output",
    {
      action: "status",
      snapshot: { ...snapshot, state: "failed", exitCode: 9, droppedLogBytes: 50 },
    },
  ],
  [
    "keeps same-named tasks' independent warnings attributable",
    {
      action: "list",
      tasks: [
        { ...snapshot, id: "task-a", name: "worker", state: "stopping" },
        { ...snapshot, id: "task-b", name: "worker", state: "stopping" },
      ],
    },
  ],
  [
    "shows retained-output recovery only when expanded",
    { action: "logs", logs: { id: "task-1", state: "running", ...cursors, droppedBytes: 50 } },
  ],
] as const)("%s", (_name, details) => {
  const args = { action: details.action, ...(details.action !== "list" && { id: snapshot.id }) };
  const summary = projectBackgroundTaskCompactSummary({
    phase: "settled",
    args,
    result: { details },
    isError: false,
  });
  const issues = summary?.issues ?? [];
  expect(issues.some((issue) => issue.severity !== "info")).toBe(true);
  const marker = "Original task result marker";
  for (const mode of ["on", "off", "border"] as const) {
    const result = { content: [{ type: "text" as const, text: marker }], details };
    const before = structuredClone(result);
    const harness = createToolPresentationHarness(registeredTool(mode));
    for (const expanded of [false, true, false, true]) {
      harness.call(args, { expanded });
      harness.result(result, { expanded });
      const text = harness.render(240).join("\n");
      for (const issue of issues) {
        const visible = expanded || issue.severity !== "info";
        const same = issues.filter((other) => other.message === issue.message).length;
        expect(occurrences(text, issue.message)).toBe(visible ? same : 0);
        if (!issue.detail) continue;
        // Multi-line details wrap under their message; check each line.
        for (const line of issue.detail.split("\n")) expect(text.includes(line)).toBe(expanded);
      }
      expect(text.includes(marker)).toBe(expanded);
    }
    expect(result).toEqual(before);
  }
});

it("shows a task's full reported error only when expanded", () => {
  const error = "Spawn failed\nENOENT: missing-binary-marker";
  const details = { action: "status", snapshot: { ...snapshot, state: "failed", error } };
  const result = { content: [{ type: "text" as const, text: "task-1 failed" }], details };
  const harness = createToolPresentationHarness(registeredTool("on"), { width: 200 });
  const args = { action: "status", id: "task-1" };
  for (const { expanded, text } of harness.cycle(args, result, { states: [false, true] })) {
    expect(text).toContain("Spawn failed");
    if (expanded) expect(text).toContain("ENOENT: missing-binary-marker");
    else expect(text).not.toContain("missing-binary-marker");
  }
});

it("keeps the owned log metadata header and all expanded logs without another cursor footer", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `log entry ${index}`);
  const header = "[task-1 state=running cursor=123 earliest=45]";
  const result = {
    content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }],
    details: {
      action: "logs",
      logs: {
        id: "task-1",
        state: "running",
        ...cursors,
        nextCursor: 123,
        earliestAvailableCursor: 45,
      },
    },
  };
  const before = structuredClone(result);
  const harness = createToolPresentationHarness(registeredTool("on"), { width: 120 });
  const cycled = harness.cycle({ action: "logs", id: "task-1" }, result, {
    states: [true, false, true],
    overrides: () => ({ executionStarted: true, isPartial: false }),
  });
  for (const { text } of cycled.filter(({ expanded }) => expanded)) {
    expect(text.match(/123/g)).toHaveLength(1);
    expect(text.match(/45/g)).toHaveLength(1);
    for (const line of lines) expect(text).toContain(line);
  }
  expect(result).toEqual(before);
});

it("uses the registering owner's scheduler and releases it when the call settles", () => {
  const scheduler = animationSchedulerProbe();
  const tool = registeredTool("on", "compact", scheduler.schedule);
  const [probe] = probeAnimationOwnership([tool], scheduler, {
    args: () => ({ action: "wait", id: "task-1" }),
  });
  expect(probe?.scheduled).toBeGreaterThan(0);
  expect(probe?.invalidated).toBe(true);
  expect(probe?.stops).toBeGreaterThan(0);
});

it("names the task, never its ID, in the collapsed preview heading and body", () => {
  const named = { ...snapshot, name: "dev-server-name", state: "failed", exitCode: 1 };
  const cases = [
    { args: { action: "status", id: "task-1" }, details: { action: "status", snapshot: named } },
    { args: { action: "stop", id: "task-1" }, details: { action: "stop", snapshot: named } },
    {
      args: { action: "wait", id: "task-1", until: "exit" },
      details: {
        action: "wait",
        wait: { id: "task-1", outcome: "completed", snapshot: named, ...cursors },
      },
    },
    { args: { action: "list" }, details: { action: "list", tasks: [named] } },
    { args: { action: "stop_all" }, details: { action: "stop_all", tasks: [named] } },
  ];
  for (const { args, details } of cases) {
    const harness = createToolPresentationHarness(registeredTool("on", "preview"), { width: 160 });
    const result = { content: [{ type: "text" as const, text: "task-1 raw agent text" }], details };
    for (const { expanded, text } of harness.cycle(args, result, { states: [false, true] })) {
      expect(text).toContain("dev-server-name");
      expect(text.split("\n")[0]).not.toMatch(/task-1|stop_all/u);
      // The agent's raw text, IDs included, is reachable only once expanded.
      if (expanded) expect(text).toContain("task-1 raw agent text");
      else expect(text).not.toContain("task-1");
    }
  }
});

it("shows a running call as running until its result arrives", () => {
  const args = { action: "wait", id: "task-1", until: "exit" };
  const render = (
    live: { executionStarted: boolean; isPartial: boolean },
    result?: Parameters<ReturnType<typeof createToolPresentationHarness>["result"]>[0],
  ) => {
    const harness = createToolPresentationHarness(registeredTool("on", "preview"));
    harness.call(args, live);
    if (result) harness.result(result, live);
    return harness.render(120);
  };
  const pending = render({ executionStarted: false, isPartial: true });
  const running = render({ executionStarted: true, isPartial: true });
  // Running adds one line under the same heading; the settled result replaces it.
  expect(running.slice(0, pending.length)).toEqual(pending);
  expect(running).toHaveLength(pending.length + 1);
  const details = {
    action: "wait",
    wait: { id: "task-1", outcome: "completed", snapshot, ...cursors },
  };
  const settled = render(
    { executionStarted: true, isPartial: false },
    { content: [{ type: "text" as const, text: "done" }], details },
  );
  expect(settled).not.toContain(running.at(-1));
});

it("bounds collapsed log previews and counts only log lines", () => {
  const lines = Array.from({ length: 30 }, (_, index) => `log entry ${index}`);
  const result = {
    content: [
      {
        type: "text" as const,
        text: `[task-1 state=running cursor=123 earliest=45]\n${lines.join("\n")}\n`,
      },
    ],
    details: { action: "logs", logs: { id: "task-1", state: "running", ...cursors } },
  };
  const harness = createToolPresentationHarness(registeredTool("on", "preview"));
  harness.call({ action: "logs", id: "task-1" }, { executionStarted: true, isPartial: false });
  harness.result(result, { expanded: false });
  const collapsed = harness.render(120).join("\n");
  expect(collapsed).toContain(lines[0]);
  expect(collapsed).toContain(lines.at(-1));
  expect(collapsed).not.toContain(lines[15]);
  expect(collapsed).not.toContain("cursor=123");
  // The count of shown lines is out of the 30 log lines, not the 31 lines of text.
  expect(collapsed).toMatch(/\b30\b/u);
  expect(collapsed).not.toMatch(/\b31\b/u);
  harness.call({ action: "logs", id: "task-1" }, { expanded: true, isPartial: false });
  harness.result(result, { expanded: true });
  const expanded = harness.render(120);
  for (const line of lines) expect(expanded.join("\n")).toContain(line);
  expect(expanded.at(-1)?.trim()).not.toBe("");
});
