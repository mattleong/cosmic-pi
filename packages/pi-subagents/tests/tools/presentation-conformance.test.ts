import { beforeEach, expect, it } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  probeAnimationOwnership,
  withPresentationSettings,
} from "pi-code-previews/testing";
import type { SubagentToolRuntime } from "../../src/tools/execute.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { compactToolDetails } from "../../src/tools/details.ts";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);
function registered(panel = false, runtime: Partial<SubagentToolRuntime> = {}) {
  return captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("render-only fixture")),
      startUiTicker: () => () => undefined,
      toolPresentation: {
        beginStart: () => () => undefined,
        beginAwait: () => () => undefined,
        isLiveHierarchyAvailable: () => panel,
      },
      ...runtime,
    }),
  ).tools;
}

it.each(["compact", "preview"] as const)(
  "preserves complete launch tasks in %s expansion",
  (style) => {
    const tool = withPresentationSettings(
      { toolCallCollapsedStyle: style },
      () => registered().find((entry) => entry.name === "subagent_start")!,
    );
    const task = `${"Task context. ".repeat(60)}\nTASK_TAIL\n\u009dCONTROL_ADJACENT_EVIDENCE`;
    const input = {
      agents: [{ name: "Worker", profile: "worker", task, isolation: "worktree" }],
    };
    const original = structuredClone(input);
    const harness = createToolPresentationHarness(tool, { width: 120 });
    for (const expanded of [false, true, false, true]) {
      harness.call(input, { expanded });
      const text = harness.render().join("\n");
      for (const evidence of ["TASK_TAIL", "CONTROL_ADJACENT_EVIDENCE"])
        expect(text.includes(evidence)).toBe(expanded);
      expect(text).not.toContain("\u009d");
    }
    expect(input).toEqual(original);
  },
);

it("retains malformed and historical evidence through expansion for every root registration", () => {
  for (const tool of registered()) {
    const harness = createToolPresentationHarness(tool);
    for (const expanded of [false, true, false, true]) {
      harness.call({}, { expanded });
      harness.result(
        {
          content: [{ type: "text", text: "historical evidence sentinel" }],
          details: { version: -1 },
        },
        { expanded },
      );
      for (const width of [32, 100]) {
        const rows = harness.render(width);
        if (expanded) expect(rows.join("\n")).toContain("historical evidence sentinel");
      }
    }
  }
});

it("preserves host-flagged uncertainty, exact input and full output through compact expansion", () => {
  const tool = registered().find((entry) => entry.name === "subagent_send")!;
  const details = compactToolDetails({
    action: "send",
    runs: [],
    actionFailures: [
      {
        id: "target",
        code: "claude_steering_outcome_uncertain",
        message: "Native input may already have arrived. Do not resend.",
      },
    ],
  });
  const result = {
    content: [
      { type: "text" as const, text: "full output beyond bounded projection; middleware evidence" },
    ],
    details,
  };
  const original = structuredClone(result);
  const harness = createToolPresentationHarness(tool, { width: 160 });
  for (const { expanded, text } of harness.cycle(
    { runIds: ["target"], message: "exact unique guidance input" },
    result,
    { overrides: () => ({ isError: true }) },
  )) {
    expect(text).toContain("unconfirmed");
    expect(text).not.toMatch(/\bfail(?:ed|ure)?\b|\bsent\b/i);
    expect(text.includes("claude_steering_outcome_uncertain")).toBe(expanded);
    expect(text.includes("Do not resend")).toBe(expanded);
    expect(text.includes("exact unique guidance input")).toBe(expanded);
    expect(text.includes("full output beyond bounded projection; middleware evidence")).toBe(
      expanded,
    );
  }
  expect(result).toEqual(original);
});
it("animates with the registering owner and releases the ticker on settlement", () => {
  const scheduler = animationSchedulerProbe();
  const tools = registered(false, { scheduleAnimation: scheduler.schedule });
  const [report] = probeAnimationOwnership(tools, scheduler, {
    filter: (tool) => tool.name === "subagent_status",
    args: () => ({ runIds: ["agent-1"] }),
    result: () => ({
      content: [],
      details: compactToolDetails({ action: "status", runs: [] }),
    }),
  });
  expect(report?.scheduled).toBeGreaterThan(0);
  expect(report).toMatchObject({ invalidated: true, stops: 1 });
});
