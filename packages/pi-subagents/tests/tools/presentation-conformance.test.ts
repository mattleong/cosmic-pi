import { visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { effectTest } from "../support/effect-test.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import { compactWorkspaceSummary } from "../../src/tools/compact-workspace-summary.ts";
import { SubagentService } from "../../src/run/service.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { beforeEach, expect, it } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  probeAnimationOwnership,
  withPresentationSettings,
  type ToolPresentationHarness,
} from "pi-code-previews/testing";
import type { SubagentToolRuntime } from "../../src/tools/execute.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { awaitDetails, compactToolDetails } from "../../src/tools/details.ts";
import { view } from "./fixtures/tool-harness.ts";
import { containedWriter } from "../fixtures/run-view.ts";

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
  "preserves complete launch tasks and file claims in %s expansion",
  (style) => {
    const tool = withPresentationSettings(
      { toolCallCollapsedStyle: style },
      () => registered().find((entry) => entry.name === "subagent_start")!,
    );
    const task = `${"Task context. ".repeat(60)}\nTASK_TAIL\n\u009dCONTROL_ADJACENT_EVIDENCE`;
    const input = {
      agents: [{ name: "Worker", profile: "worker", task, writes: ["src/claimed-file.ts"] }],
    };
    const original = structuredClone(input);
    const harness = createToolPresentationHarness(tool, { width: 120 });
    for (const expanded of [false, true, false, true]) {
      harness.call(input, { expanded });
      const text = harness.render().join("\n");
      for (const evidence of ["TASK_TAIL", "CONTROL_ADJACENT_EVIDENCE", "src/claimed-file.ts"])
        expect(text.includes(evidence)).toBe(expanded);
      expect(text).not.toContain("\u009d");
    }
    expect(input).toEqual(original);
  },
);

it.each(["compact", "preview"] as const)(
  "preserves uneven retained report lengths in %s expansion",
  (style) => {
    const tool = withPresentationSettings(
      { toolCallCollapsedStyle: style },
      () => registered().find((entry) => entry.name === "subagent_await")!,
    );
    const finalText = `${"Report evidence. ".repeat(1_900)}\nLONG_REPORT_TAIL`;
    const runs = [
      view({ id: "long-report", state: "completed", finalText }),
      view({ id: "short-report", state: "completed", finalText: "SHORT_REPORT_BODY" }),
    ];
    const details = awaitDetails({ runs, awaitUntil: "all_finished" });
    expect(details.contentOmitted).not.toBe(true);
    expect(details.cards[0]?.finalText).toBe(finalText);
    const result = { content: [], details };
    const original = structuredClone(result);
    const harness = createToolPresentationHarness(tool, { width: 120 });
    for (const { expanded, text } of harness.cycle(
      { runIds: runs.map((run) => run.id), until: "all_finished" },
      result,
    ))
      for (const evidence of ["LONG_REPORT_TAIL", "SHORT_REPORT_BODY"])
        expect(text.includes(evidence)).toBe(expanded);
    expect(result).toEqual(original);
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
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        if (expanded) expect(rows.join("\n")).toContain("historical evidence sentinel");
      }
    }
  }
});

it("keeps parent recovery visible when a live panel hides partial hierarchy", () => {
  const tool = registered(true).find((candidate) => candidate.name === "subagent_await")!;
  const details = awaitDetails({
    runs: [
      view({
        id: "target",
        state: "waiting_for_parent",
        question: { requestId: "question", message: "grant the reviewed file" },
      }),
    ],
    awaitUntil: "all_finished",
    attentionRequired: true,
  });
  const harness = createToolPresentationHarness(tool, { width: 100 });
  for (const { expanded, text } of harness.cycle(
    { runIds: ["target"], until: "all_finished" },
    { content: [], details },
    { overrides: () => ({ isPartial: true }) },
  )) {
    expect(text).toContain("grant the reviewed file");
    expect(text.includes("subagent_reply")).toBe(expanded);
    expect(text.match(/subagent_await/g)?.length).toBeGreaterThan(0);
  }
});

effectTest(
  "preserves unavailable-only workspace diagnostics through compact expansion",
  function* () {
    const artifact = {
      workspaceId: "unavailable-artifact",
      status: "unavailable",
      reason: "recovery-record-unavailable",
    } as const;
    const response = yield* executeWorkspaceAction({ action: "list" }).pipe(
      Effect.provideService(
        SubagentService,
        subagentServiceDouble({
          workspaceList: () => Effect.succeed({ records: [], unavailable: [artifact] }),
        }),
      ),
      Effect.orDie,
    );
    expect(response.details).toMatchObject({
      workspaceCount: 1,
      listedCount: 1,
      unavailableCount: 1,
    });
    const summary = compactWorkspaceSummary(response, "list")!;
    expect(summary.outcome).toBe("warning");
    const warning = summary.issues!.find((issue) => issue.severity === "warning")!;
    expect(warning.detail).toBeTruthy();
    const tool = registered().find((candidate) => candidate.name === "subagent_workspace")!;
    const harness = createToolPresentationHarness(tool, { width: 200 });
    for (const { expanded, text } of harness.cycle({ action: "list" }, response)) {
      expect(text).toContain(warning.message);
      expect(text.includes(warning.detail!)).toBe(expanded);
      if (expanded) {
        expect(text).toContain(artifact.workspaceId);
        expect(text).toContain(artifact.reason);
        expect(text).toContain("Do not auto-adopt or delete an orphan");
      }
    }
  },
);

it("keeps workspace diff bytes without repeating generated recovery", () => {
  const tool = registered().find((candidate) => candidate.name === "subagent_workspace")!;
  const harness = createToolPresentationHarness(tool);
  const prefix = "legacy generated status\n";
  const diff = "diff --git a/file b/file\n+preserved evidence";
  harness.call({ action: "review", workspaceId: "workspace" }, { expanded: true });
  harness.result(
    {
      content: [{ type: "text", text: prefix + diff + "\nlegacy generated recovery" }],
      details: {
        version: 1,
        action: "workspace",
        operation: "review",
        workspaceId: "workspace",
        revisionId: "revision",
        offset: 0,
        totalChars: diff.length,
        displayContent: { offset: prefix.length, length: diff.length },
      },
    },
    { expanded: true },
  );
  const text = harness.render(100).join("\n");
  expect(text).toContain("+preserved evidence");
  expect(text).not.toContain("legacy generated");
  expect(text).toContain("Read ALL pages");
});

effectTest("preserves preparation paths omitted from bounded metadata", function* () {
  const cwd = "/project/" + "directory/".repeat(107);
  const input = { action: "prepare" as const, workspaceId: "workspace", revisionId: "revision" };
  const result = yield* executeWorkspaceAction(input).pipe(
    Effect.provideService(
      SubagentService,
      subagentServiceDouble({
        workspacePrepare: () =>
          Effect.succeed({
            preparationId: "preparation",
            revisionId: "revision",
            cwd,
            leaseDirectories: [],
          }),
      }),
    ),
    Effect.orDie,
  );
  expect(result.details.preparedCwd).toBeUndefined();
  expect(result.content[0]?.type === "text" && result.content[0].text).toContain(cwd);
  const original = structuredClone(result);
  const tool = registered().find((entry) => entry.name === "subagent_workspace")!;
  const harness = createToolPresentationHarness(tool);
  for (const details of [
    result.details,
    { ...result.details, displayContent: { offset: 0, length: 0 } },
  ]) {
    harness.call(input, { expanded: true });
    harness.result({ ...result, details }, { expanded: true });
    expect(harness.render(2000).join("\n")).toContain(cwd);
  }
  expect(result).toEqual(original);
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

const pendingInput = { runIds: ["confirmed", "pending-target"], message: "exact pending guidance" };
const pendingImage = {
  type: "image" as const,
  mimeType: "image/png",
  data: "cGVuZGluZy1uYXRpdmUtaW1hZ2U=",
};
const definiteFailure = { id: "bad", code: "not_running", message: "Not running" };
const pendingSend = (extra: ReadonlyArray<typeof definiteFailure> = []) => ({
  content: [
    { type: "text" as const, text: "raw pending output sentinel; middleware evidence" },
    pendingImage,
  ],
  details: compactToolDetails({
    action: "send",
    runs: [view({ id: "confirmed" })],
    actionFailures: [
      {
        id: "pending-target",
        code: "steer_outcome_uncertain",
        message: "Guidance may have been sent; acknowledgement is pending. Do not resend.",
        pendingDelivery: true,
      },
      ...extra,
    ],
  }),
});
const reportsFailure = /\bfail(?:ed|ure)?\b/i;

function renderUnchanged(
  harness: ToolPresentationHarness,
  result: ReturnType<typeof pendingSend>,
  state: { readonly expanded: boolean; readonly isError: boolean },
): string {
  const original = structuredClone(result);
  harness.call(pendingInput, state);
  harness.result(result, state);
  const text = harness.render(160).join("\n");
  expect(result).toEqual(original);
  expect(result.content[1]).toBe(pendingImage);
  expect(text).not.toContain(pendingImage.data);
  return text;
}

it("expands pending delivery evidence without claiming failure and keeps definite failures distinct", () => {
  const tool = registered().find((entry) => entry.name === "subagent_send")!;
  const harness = createToolPresentationHarness(tool);
  for (const expanded of [false, true, false, true]) {
    const text = renderUnchanged(harness, pendingSend(), { expanded, isError: false });
    expect(text).toContain("awaiting confirmation");
    expect(text).not.toMatch(reportsFailure);
    expect(text.includes("steer_outcome_uncertain")).toBe(expanded);
    expect(text.includes("pending-target")).toBe(expanded);
    expect(text.includes("Do not resend")).toBe(expanded);
    expect(text.includes("exact pending guidance")).toBe(expanded);
    expect(text.includes("raw pending output sentinel; middleware evidence")).toBe(expanded);
  }
  for (const expanded of [false, true, false, true]) {
    const mixed = pendingSend([definiteFailure]);
    const text = renderUnchanged(harness, mixed, { expanded, isError: true });
    expect(text).toContain("awaiting confirmation");
    expect(text).toMatch(reportsFailure);
    for (const evidence of ["steer_outcome_uncertain", "Do not resend", definiteFailure.code])
      expect(text.includes(evidence)).toBe(expanded);
    expect(text.includes("raw pending output sentinel; middleware evidence")).toBe(expanded);
  }
});

it("gives pending delivery only no-resend recovery in the default preview style", () => {
  const tool = withPresentationSettings(
    { toolCallCollapsedStyle: "preview" },
    () => registered().find((entry) => entry.name === "subagent_send")!,
  );
  for (const expanded of [false, true]) {
    const harness = createToolPresentationHarness(tool);
    const pending = renderUnchanged(harness, pendingSend(), { expanded, isError: false });
    expect(pending).toContain("exact pending guidance");
    expect(pending).toContain("awaiting confirmation");
    expect(pending.includes("steer_outcome_uncertain")).toBe(expanded);
    expect(pending.includes("pending-target")).toBe(expanded);
    expect(/do not resend/i.test(pending)).toBe(expanded);
    expect(pending).not.toMatch(reportsFailure);
    expect(pending).not.toMatch(/then retry|before retrying|resend it/i);
    const mixed = renderUnchanged(harness, pendingSend([definiteFailure]), {
      expanded,
      isError: true,
    });
    expect(/do not resend/i.test(mixed)).toBe(expanded);
    expect(mixed).toMatch(reportsFailure);
    expect(mixed.includes(definiteFailure.code)).toBe(expanded);
  }
});

it("draws each issue once and keeps IDs and agent procedures out of collapsed previews", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const tools = registered();
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  const paused = view({ id: "agent-paused-7", state: "paused" });
  const failed = {
    id: "agent-missing-9",
    code: "run_waiting_for_parent",
    message:
      'Subagent agent-missing-9 is waiting; use subagent_reply({ runId: "agent-missing-9" }).',
  };
  for (const [name, args, details] of [
    [
      "subagent_await",
      { runIds: [paused.id], until: "all_finished" },
      awaitDetails({ runs: [paused], awaitUntil: "all_finished", attentionRequired: true }),
    ],
    [
      "subagent_lifecycle",
      { action: "stop", runIds: [paused.id, failed.id] },
      compactToolDetails({ action: "stop", runs: [paused], actionFailures: [failed] }),
    ],
    [
      "subagent_send",
      { runIds: [failed.id], message: "guidance" },
      compactToolDetails({ action: "send", runs: [], actionFailures: [failed] }),
    ],
  ] as const) {
    const harness = createToolPresentationHarness(tool(name));
    for (const expanded of [false, true]) {
      const state = { expanded, isError: name !== "subagent_await" };
      harness.call(args, state);
      harness.result({ content: [{ type: "text", text: "Agent-facing text" }], details }, state);
      const lines = harness.render(200);
      const text = lines.join("\n");
      if (!expanded) {
        for (const id of [paused.id, failed.id]) expect(text).not.toContain(id);
        expect(text).not.toMatch(/subagent_\w+\(|Next:/u);
      }
      const issueLines = lines.filter((line) => /^[⚠✗ℹ] /u.test(line));
      expect(new Set(issueLines).size).toBe(issueLines.length);
    }
  }
});

it("counts a preview-style call's targets as execution reads them", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const tools = registered();
  for (const [name, args] of [
    ["subagent_status", {}],
    ["subagent_send", { message: "guidance" }],
    ["subagent_lifecycle", { action: "stop" }],
  ] as const) {
    const harness = createToolPresentationHarness(
      tools.find((candidate) => candidate.name === name)!,
    );
    harness.call({ ...args, runIds: ["agent-1", " agent-1 "] }, { expanded: false });
    const text = harness.render(120).join("\n");
    expect(text).toContain("1 subagent");
    expect(text).not.toContain("2 subagents");
  }
});

it("keeps agent recovery steps out of the collapsed preview style", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const tool = registered().find((entry) => entry.name === "subagent_await")!;
  for (const [run, human] of [
    [view({ state: "paused" }), "is paused"],
    [
      view({
        state: "waiting_for_parent",
        question: { requestId: "q", message: "May I edit db/0007.sql?" },
      }),
      "May I edit db/0007.sql?",
    ],
    [containedWriter({ state: "running" }), "src/b.ts"],
  ] as const) {
    const details = awaitDetails({
      runs: [run],
      awaitUntil: "all_finished",
      attentionRequired: true,
    });
    const harness = createToolPresentationHarness(tool, { width: 120 });
    const args = { runIds: [run.id], until: "all_finished" };
    const result = { content: [], details };
    for (const { expanded, text } of harness.cycle(args, result, {
      states: [false, true, false],
    })) {
      expect(text).toContain(human);
      expect(/subagent_\w+\(/u.test(text)).toBe(expanded);
    }
  }
});

it.each(["compact", "preview"] as const)(
  "keeps accepted reports and cleanup quarantine independent in registered %s callbacks",
  (style) => {
    const tools = withPresentationSettings({ toolCallCollapsedStyle: style }, () => registered());
    const run = view({
      id: "quarantined-run",
      name: "Cleanup worker",
      state: "completed",
      finalText: "Accepted report evidence sentinel",
      writeIntent: "writer",
      writeAudit: { observedFileWrites: [], violations: [], bashWriteHints: 0 },
      cleanup: {
        disposition: "quarantined",
        recovery: "stop",
        diagnostic: {
          phase: "process-group",
          code: "group_live",
          message: "Cleanup diagnostic head\nCleanup diagnostic tail sentinel",
        },
      },
      writerCleanupQuarantined: true,
    });
    for (const toolName of ["subagent_await", "subagent_lifecycle"] as const) {
      const awaiting = toolName === "subagent_await";
      const details = awaiting
        ? awaitDetails({
            runs: [run],
            awaitedRunIds: [run.id],
            awaitUntil: "all_finished",
            attentionRequired: true,
          })
        : compactToolDetails({ action: "stop", runs: [run] });
      const result = { content: [], details };
      const original = structuredClone(result);
      const harness = createToolPresentationHarness(tools.find((tool) => tool.name === toolName)!, {
        width: 160,
      });
      for (const { expanded, text } of harness.cycle(
        { runIds: [run.id], ...(awaiting ? { until: "all_finished" } : { action: "stop" }) },
        result,
      )) {
        expect(text).toMatch(/cleanup.*unconfirmed/i);
        expect(text).not.toMatch(/resume_admission|outside.*claims|wrote to|worker failed/i);
        expect(text.includes("Cleanup diagnostic tail sentinel")).toBe(expanded);
        expect(text.includes("group_live")).toBe(expanded);
        if (awaiting) expect(text.includes("Accepted report evidence sentinel")).toBe(expanded);
      }
      expect(result).toEqual(original);
    }
    const tool = tools.find((entry) => entry.name === "subagent_lifecycle")!;
    for (const writerCleanupQuarantined of [false, true]) {
      const confirmed = compactToolDetails({
        action: "stop",
        runs: [{ ...run, cleanup: { disposition: "confirmed" }, writerCleanupQuarantined }],
      });
      const harness = createToolPresentationHarness(tool);
      harness.call({ action: "stop", runIds: [run.id] }, { expanded: false });
      harness.result({ content: [], details: confirmed }, { expanded: false });
      expect(/cleanup quarantine/i.test(harness.render(160).join("\n"))).toBe(
        writerCleanupQuarantined,
      );
    }
  },
);

it.each(["compact", "preview"] as const)(
  "sanitizes historical cleanup diagnostic codes in %s expansion",
  (style) => {
    const tool = withPresentationSettings(
      { toolCallCollapsedStyle: style },
      () => registered().find((entry) => entry.name === "subagent_status")!,
    );
    const base = compactToolDetails({ action: "status", runs: [view({ state: "completed" })] });
    if (!("cards" in base)) throw new Error("Expected run cards.");
    const details = {
      ...base,
      cards: base.cards.map((card) =>
        Object.assign({}, card, {
          cleanup: {
            disposition: "quarantined",
            recovery: "manual",
            diagnostic: {
              phase: "backend-scope",
              code: "\u001b[31mapi_key=historical-secret",
              message: "Historical cleanup evidence",
            },
          },
        }),
      ),
    };
    const harness = createToolPresentationHarness(tool);
    for (const { text, expanded } of harness.cycle(
      { runIds: ["agent-1"] },
      { content: [], details },
    )) {
      expect(text).not.toContain("historical-secret");
      expect(text).not.toContain("\u001b");
      expect(text.includes("Historical cleanup evidence")).toBe(expanded);
    }
  },
);

it("retains failures, cancelled waits and uncertain cleanup across expansion toggles", () => {
  const tool = registered().find((entry) => entry.name === "subagent_await")!;
  for (const scenario of [
    {
      state: "failed" as const,
      error: "failure evidence sentinel",
      cancelled: false,
      evidence: "failure evidence sentinel",
    },
    { state: "running" as const, cancelled: true, evidence: "NOT stopped" },
    { state: "stopping" as const, cancelled: false, evidence: "cleanup is not yet confirmed" },
  ]) {
    const details = awaitDetails({
      runs: [view({ id: "target", ...scenario })],
      awaitUntil: "all_finished",
      cancelled: scenario.cancelled,
      cancellationCleanup: "unconfirmed",
    });
    const harness = createToolPresentationHarness(tool, { width: 120 });
    const args = { runIds: ["target"], until: "all_finished" };
    for (const { expanded, text } of harness.cycle(args, { content: [], details })) {
      if (expanded) expect(text).toContain(scenario.evidence);
      else {
        expect(text).not.toContain("subagent_status");
        if (scenario.error) expect(text).toContain(scenario.error);
        if (scenario.cancelled) expect(text).toMatch(/were not stopped/i);
        if (scenario.state === "stopping") expect(text).toMatch(/stopping.*cleanup/i);
      }
      if (expanded && scenario.error) expect(text.split(scenario.error)).toHaveLength(2);
      if (scenario.cancelled) expect(text.includes("completion_claim_conflict")).toBe(expanded);
    }
  }
});

it("stops an expanded await ticker when a declined summary collapses", () => {
  const ticks = new Set<() => void>();
  const tool = registered(false, {
    startUiTicker: (_interval, tick) => {
      ticks.add(tick);
      return () => ticks.delete(tick);
    },
  }).find((entry) => entry.name === "subagent_await")!;
  const details = awaitDetails({
    runs: [view({ id: "target", state: "running" })],
    awaitUntil: "all_finished",
  });
  const harness = createToolPresentationHarness(tool, { width: 120 });
  let invalidations = 0;
  for (const expanded of [true, false]) {
    const state = {
      expanded,
      executionStarted: true,
      isPartial: true,
      isError: !expanded,
      invalidate: () => void invalidations++,
    };
    harness.call({ runIds: ["target"], until: "all_finished" }, state);
    harness.result({ content: [], details: expanded ? details : undefined }, state);
    harness.render();
    for (const tick of ticks) tick();
    expect(ticks.size).toBe(expanded ? 1 : 0);
    expect(invalidations).toBe(1);
  }
});

it("keeps the sole await heading when the live panel owns the result", () => {
  const details = { version: 2, action: "await", cards: [], awaitUntil: "all_finished" };
  for (const panelOwns of [false, true]) {
    const tool = registered(panelOwns).find((entry) => entry.name === "subagent_await")!;
    const harness = createToolPresentationHarness(tool, { width: 120 });
    const frames = harness.cycle(
      { runIds: ["target"], until: "all_finished" },
      { content: [], details },
      {
        states: [true, false, true],
        overrides: () => ({ executionStarted: true, isPartial: true }),
      },
    );
    for (const { text } of frames) expect(text.match(/subagent_await/g)).toHaveLength(1);
  }
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
