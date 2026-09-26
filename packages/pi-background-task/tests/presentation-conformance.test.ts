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
      if (expanded) {
        expect(text).toContain("Raw task result");
        expect(text).toContain(marker);
      } else expect(text).not.toContain(marker);
    }
    expect(result).toEqual(before);
  }
});

it("shows a task's full reported error only when expanded", () => {
  const error = "Spawn failed\nENOENT: missing-binary-marker";
  const details = { action: "status", snapshot: { ...snapshot, state: "failed", error } };
  const result = { content: [{ type: "text" as const, text: "task-1 failed" }], details };
  const harness = createToolPresentationHarness(registeredTool("on"));
  for (const expanded of [false, true]) {
    harness.call({ action: "status", id: "task-1" }, { expanded });
    harness.result(result, { expanded });
    const text = harness.render(200).join("\n");
    expect(text).toContain("Spawn failed");
    if (expanded) expect(text).toContain("ENOENT: missing-binary-marker");
    else expect(text).not.toContain("missing-binary-marker");
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
  expect(summary?.issues?.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["task-1:exit-code", "task-1:log-loss"]),
  );
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
