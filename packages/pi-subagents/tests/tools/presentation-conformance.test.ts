import { beforeEach, expect, it } from "vitest";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { argumentFailureIssue, withCodePreviewShell } from "pi-code-previews";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  probeAnimationOwnership,
  withPresentationSettings,
} from "pi-code-previews/testing";
import { stripAnsi } from "pi-cosmic-core";
import { piArgumentRejection } from "pi-cosmic-core/testing/sdk";
import type { SubagentToolRuntime } from "../../src/tools/execute.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
import {
  CONTACT_PARENT_LABEL,
  contactParentCompactSummary,
  contactParentExpandedContent,
  contactParentRenderers,
} from "../../src/tools/render-parent.ts";

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
      () => registered().find((entry) => entry.name === "agent_start")!,
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

it.each(["compact", "preview"] as const)(
  "explains Pi's rejection of malformed arguments in %s style and keeps all of it expanded",
  (style) => {
    applyPresentationSettings({ toolCallCollapsedStyle: style });
    for (const tool of registered()) {
      // Malformed tool-call JSON reaches the renderers as `{}` with Pi's own rejection text.
      const rejection = piArgumentRejection(tool, '{"agents":[{"task":"Map the auth flow');
      const issue = argumentFailureIssue(rejection);
      expect(issueMessageStyleProblems(issue?.message ?? "")).toEqual([]);
      const [collapsed, expanded] = createToolPresentationHarness(tool, { width: 200 })
        .cycle(
          {},
          { content: [{ type: "text", text: rejection }], details: {} },
          {
            states: [false, true],
            overrides: () => ({ isError: true, isPartial: false }),
          },
        )
        .map((frame) => stripAnsi(frame.text));
      expect(collapsed, tool.name).toContain(issue?.message);
      expect(collapsed, tool.name).not.toContain(rejection.split("\n")[0]);
      for (const line of rejection.split("\n").filter(Boolean))
        expect(expanded, tool.name).toContain(line);
    }
  },
);

const contactParent = () =>
  withCodePreviewShell(
    defineTool({
      ...contactParentRenderers,
      name: "agent_contact_parent",
      label: CONTACT_PARENT_LABEL,
      description: CONTACT_PARENT_LABEL,
      parameters: Type.Object({}),
      execute: () => Promise.reject(new Error("render-only fixture")),
    }),
    { compactSummary: contactParentCompactSummary, expandedContent: contactParentExpandedContent },
  );

it("names only the tool for a call Pi rejected as malformed JSON, not for one that ran", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  for (const tool of [...registered(), contactParent()]) {
    const callRows = (overrides: { expanded: boolean; isError: boolean; durationMs?: number }) =>
      stripAnsi(
        createToolPresentationHarness(tool, { width: 120 })
          .call(
            {},
            { isPartial: false, executionStarted: true, durationMs: undefined, ...overrides },
          )
          ?.render(120)
          .join("\n") ?? "",
      ).trim();
    for (const expanded of [false, true]) {
      // Pi parses malformed tool-call JSON as `{}` and records a duration only for calls that ran,
      // so defaults that `{}` implies describe only an executed call.
      expect(callRows({ expanded, isError: true }), tool.name).toBe(tool.label);
      expect(callRows({ expanded, isError: true, durationMs: 12 }), tool.name).toBe(
        callRows({ expanded, isError: false, durationMs: 12 }),
      );
    }
  }
});

it("preserves host-flagged uncertainty, exact input and full output through compact expansion", () => {
  const tool = registered().find((entry) => entry.name === "agent_lifecycle")!;
  const details = compactToolDetails({
    action: "interrupt",
    runs: [],
    actionFailures: [
      {
        id: "exact-unique-target-input",
        code: "interrupt_outcome_uncertain",
        message: "The pause request may already have applied. Do not resend.",
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
    { action: "interrupt", runIds: ["exact-unique-target-input"] },
    result,
    { overrides: () => ({ isError: true }) },
  )) {
    expect(text).toMatch(/confirm/i);
    expect(text).not.toMatch(/\bfail(?:ed|ure)?\b|\bsent\b/i);
    expect(text.includes("interrupt_outcome_uncertain")).toBe(expanded);
    expect(text.includes("Do not resend")).toBe(expanded);
    expect(text.includes("exact-unique-target-input")).toBe(expanded);
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
    filter: (tool) => tool.name === "agent_lifecycle",
    args: () => ({ action: "stop", runIds: ["agent-1"] }),
    result: () => ({
      content: [],
      details: compactToolDetails({ action: "stop", runs: [] }),
    }),
  });
  expect(report?.scheduled).toBeGreaterThan(0);
  expect(report).toMatchObject({ invalidated: true, stops: 1 });
});

it("shows every call argument once a management call is expanded", () => {
  const cases = [
    ["agent_lifecycle", { action: "stop", runIds: ["RUN_ID_SENTINEL"] }, ["RUN_ID_SENTINEL"]],
    [
      "agent_await",
      { runIds: ["AWAITED_SENTINEL"], until: "any_finished", timeoutSeconds: 90 },
      ["AWAITED_SENTINEL", "90"],
    ],
    [
      "agent_worktree",
      {
        action: "apply",
        workspaceId: "WORKSPACE_SENTINEL",
        revisionId: "REVISION_SENTINEL",
        preparationId: "PREPARATION_SENTINEL",
      },
      ["WORKSPACE_SENTINEL", "REVISION_SENTINEL", "PREPARATION_SENTINEL"],
    ],
    [
      "agent_worktree",
      { action: "review", workspaceId: "ws-1", offset: 16000, limit: 4000 },
      ["16000", "4000"],
    ],
  ] as const;
  for (const [name, args, evidence] of cases) {
    const harness = createToolPresentationHarness(
      registered().find((entry) => entry.name === name)!,
      { width: 160 },
    );
    harness.call(args, { expanded: true });
    const text = harness.render().join("\n");
    for (const value of evidence) expect(text, `${name} ${value}`).toContain(value);
  }
});
