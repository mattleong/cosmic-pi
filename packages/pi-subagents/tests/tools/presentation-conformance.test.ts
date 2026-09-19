import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { effectTest } from "../support/effect-test.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import { SubagentService } from "../../src/run/service.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { afterEach, expect, it } from "vitest";
import { createToolPresentationHarness } from "pi-code-previews/testing";
import {
  codePreviewSettings,
  setCodePreviewSettings,
} from "../../../pi-code-previews/src/config/state.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { makeCompactToolDetails } from "../../src/tools/details.ts";
import type { SubagentAwaitDetails } from "../../src/tools/details-schema.ts";
import { extensionApiFixture } from "../fixtures/pi-host.ts";
import { view } from "./fixtures/tool-harness.ts";

const settings = { ...codePreviewSettings };
afterEach(() => setCodePreviewSettings(settings));
// SAFETY: Rendering only uses these styling functions.
const theme = {
  fg: (_key: string, text: string) => text,
  bg: (_key: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
function registered(panel = false) {
  setCodePreviewSettings({ ...settings, toolCallCollapsedStyle: "compact", toolCallTiming: false });
  const tools: ToolDefinition<any, any, any>[] = [];
  registerSubagentTools(
    extensionApiFixture({
      registerTool: (tool: ToolDefinition<any, any, any>) => tools.push(tool),
    }),
    {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("render-only fixture")),
      startUiTicker: () => () => undefined,
      toolPresentation: {
        beginStart: () => () => undefined,
        beginAwait: () => () => undefined,
        isLiveHierarchyAvailable: () => panel,
      },
    },
  );
  return tools;
}

it("retains malformed and historical evidence through expansion for every root registration", () => {
  for (const tool of registered()) {
    const harness = createToolPresentationHarness(tool, { theme });
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
  const projected = makeCompactToolDetails({
    action: "status",
    runs: [
      view({
        id: "target",
        state: "waiting_for_parent",
        question: { requestId: "question", message: "grant the reviewed file", createdAt: 1 },
      }),
    ],
  });
  if (projected.action === "models") throw new Error("Expected cards");
  const harness = createToolPresentationHarness(tool, { theme });
  for (const expanded of [false, true, false, true]) {
    harness.call({ runIds: ["target"], until: "all_finished" }, { expanded, isPartial: true });
    harness.result(
      {
        content: [],
        details: {
          version: 2,
          action: "await",
          cards: projected.cards,
          awaitedRunIds: ["target"],
          awaitUntil: "all_finished",
          attentionRequired: true,
        },
      },
      { expanded, isPartial: true },
    );
    const text = harness.render(100).join("\n");
    expect(text).toContain("grant the reviewed file");
    expect(text).toContain("subagent_reply");
    expect(text.match(/subagent_await/g)?.length).toBeGreaterThan(0);
  }
});

it("keeps workspace diff bytes without repeating generated recovery", () => {
  const tool = registered().find((tool) => tool.name === "subagent_workspace")!;
  const harness = createToolPresentationHarness(tool, { theme });
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
  const harness = createToolPresentationHarness(tool, { theme });
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
  const harness = createToolPresentationHarness(tool, { theme });
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
    const projected = makeCompactToolDetails({
      action: "status",
      runs: [view({ id: "target", ...scenario })],
    });
    if (projected.action === "models") throw new Error("Expected cards");
    const harness = createToolPresentationHarness(tool, { theme });
    for (const expanded of [false, true, false, true]) {
      harness.call({ runIds: ["target"], until: "all_finished" }, { expanded });
      const details: SubagentAwaitDetails = {
        version: 2,
        action: "await",
        cards: projected.cards,
        awaitedRunIds: ["target"],
        awaitUntil: "all_finished",
      };
      if (scenario.cancelled)
        Object.assign(details, { cancelled: true, cancellationCleanup: "unconfirmed" });
      harness.result({ content: [], details }, { expanded });
      const text = harness.render(120).join("\n");
      expect(text).toContain(scenario.evidence);
      if (expanded && scenario.error) expect(text.split(scenario.error)).toHaveLength(2);
      if (scenario.cancelled) expect(text).toContain("completion_claim_conflict");
    }
  }
});
