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
} from "pi-code-previews/testing";
import type { SubagentToolRuntime } from "../../src/tools/execute.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { makeAwaitDetails, makeCompactToolDetails } from "../../src/tools/details.ts";
import { view } from "./fixtures/tool-harness.ts";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);
/** Root registrations for rendering only; `panel` says whether the live panel is available. */
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
  const tool = registered(true).find((tool) => tool.name === "subagent_await")!;
  const details = makeAwaitDetails({
    runs: [
      view({
        id: "target",
        state: "waiting_for_parent",
        question: { requestId: "question", message: "grant the reviewed file", createdAt: 1 },
      }),
    ],
    awaitUntil: "all_finished",
    attentionRequired: true,
  });
  const harness = createToolPresentationHarness(tool);
  for (const expanded of [false, true, false, true]) {
    harness.call({ runIds: ["target"], until: "all_finished" }, { expanded, isPartial: true });
    harness.result({ content: [], details }, { expanded, isPartial: true });
    const text = harness.render(100).join("\n");
    expect(text.includes("grant the reviewed file")).toBe(expanded);
    expect(text.includes("subagent_reply")).toBe(expanded);
    if (!expanded) expect(text).toMatch(/needs a reply/i);
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
    const summary = compactWorkspaceSummary(response.details, "list")!;
    expect(summary.outcome).toBe("warning");
    const warning = summary.issues!.find((issue) => issue.severity === "warning")!;
    expect(warning.detail).toBeTruthy();
    const tool = registered().find((tool) => tool.name === "subagent_workspace")!;
    const harness = createToolPresentationHarness(tool);
    for (const expanded of [false, true, false, true]) {
      harness.call({ action: "list" }, { expanded });
      harness.result(response, { expanded });
      const text = harness.render(200).join("\n");
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
  const tool = registered().find((tool) => tool.name === "subagent_workspace")!;
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

it("retains unique guidance input when expansion replaces the original call heading", () => {
  const tool = registered().find((entry) => entry.name === "subagent_send")!;
  const harness = createToolPresentationHarness(tool);
  const details = makeCompactToolDetails({ action: "send", runs: [view({ id: "target" })] });
  harness.call({ runIds: ["target"], message: "unique guidance evidence" }, { expanded: true });
  harness.result({ content: [], details }, { expanded: true });
  expect(harness.render(100).join("\n")).toContain("unique guidance evidence");
});

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
    const details = makeAwaitDetails({
      runs: [view({ id: "target", ...scenario })],
      awaitUntil: "all_finished",
      cancelled: scenario.cancelled,
      cancellationCleanup: "unconfirmed",
    });
    const harness = createToolPresentationHarness(tool);
    for (const expanded of [false, true, false, true]) {
      harness.call({ runIds: ["target"], until: "all_finished" }, { expanded });
      harness.result({ content: [], details }, { expanded });
      const text = harness.render(120).join("\n");
      if (expanded) expect(text).toContain(scenario.evidence);
      else {
        expect(text).not.toContain("subagent_status");
        // An unrecognised worker error explains itself with its first line.
        if (scenario.error) expect(text).toContain(scenario.error);
        if (scenario.cancelled) expect(text).toMatch(/workers were not stopped/i);
        if (scenario.state === "stopping") expect(text).toMatch(/cleanup is not yet confirmed/i);
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
  const details = makeAwaitDetails({
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
    for (const expanded of [true, false, true]) {
      const state = { expanded, executionStarted: true, isPartial: true };
      harness.call({ runIds: ["target"], until: "all_finished" }, state);
      harness.result({ content: [], details }, state);
      const text = harness.render().join("\n");
      expect(text.match(/subagent_await/g)).toHaveLength(1);
    }
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
      details: makeCompactToolDetails({ action: "status", runs: [] }),
    }),
  });
  expect(report?.scheduled).toBeGreaterThan(0);
  expect(report).toMatchObject({ invalidated: true, stops: 1 });
});
