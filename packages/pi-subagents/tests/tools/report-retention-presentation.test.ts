import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
  withPresentationSettings,
} from "pi-code-previews/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentRunView } from "../../src/run/model.ts";
import { MAX_FINAL_TEXT_CHARS } from "../../src/run/state.ts";
import { SUBAGENT_TOOL_NAME } from "../../src/run/tool-policy.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { decodeStartAwaitCardDetails } from "../../src/tools/details-decode.ts";
import { awaitDetails } from "../../src/tools/details.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { view } from "./fixtures/tool-harness.ts";

const ARCHIVE_PATH = "/agent/subagents/reports/session-1/agent-1-1-archive.md";

const cutRun = (complete: boolean | undefined): SubagentRunView =>
  view({
    id: "agent-1",
    name: "reader",
    state: "completed",
    reportGeneration: 1,
    finalText: `${"finding\n".repeat(MAX_FINAL_TEXT_CHARS / 8 - 1)}end`,
    finalTextTruncation: {
      retainedChars: MAX_FINAL_TEXT_CHARS,
      originalChars: MAX_FINAL_TEXT_CHARS * 3,
      originalLines: 15_000,
    },
    ...(complete !== undefined && {
      reportArchive: {
        path: ARCHIVE_PATH,
        chars: MAX_FINAL_TEXT_CHARS * 3,
        lines: 15_000,
        complete,
      },
    }),
  });

const detailsFor = (run: SubagentRunView) =>
  awaitDetails({ runs: [run], awaitedRunIds: [run.id], awaitUntil: "all_finished" });

const summarize = (run: SubagentRunView) =>
  createSubagentCompactSummary(SUBAGENT_TOOL_NAME.await)({
    phase: "settled",
    args: { runIds: [run.id], until: "all_finished" },
    result: { content: [{ type: "text", text: "await output" }], details: detailsFor(run) },
    context: renderContextFixture({ isError: false }),
  });

const awaitTool = () =>
  captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("render-only fixture")),
      startUiTicker: () => () => undefined,
      toolPresentation: {
        beginStart: () => () => undefined,
        beginAwait: () => () => undefined,
        isLiveHierarchyAvailable: () => false,
      },
    }),
  ).tools.find((tool) => tool.name === SUBAGENT_TOOL_NAME.await)!;

const restoreSettings: Array<() => void> = [];

describe("cut report presentation", () => {
  beforeEach(() => {
    restoreSettings.push(applyPresentationSettings({ toolCallTiming: false }));
  });
  afterEach(() => restoreSettings.pop()?.());

  it("keeps a cut report's saved file in persisted cards, even without the report text", () => {
    const decoded = decodeStartAwaitCardDetails(detailsFor(cutRun(true)));
    const [card] = decoded?.action === "await" ? decoded.cards : [];
    expect(card?.finalTextTruncated).toBe(true);
    expect(card?.reportArchive?.path).toBe(ARCHIVE_PATH);
    expect(card?.reportTruncation?.originalChars).toBe(MAX_FINAL_TEXT_CHARS * 3);
  });

  it("points the compact issue at the saved file, and at agent_read only without one", () => {
    for (const complete of [true, false, undefined]) {
      const issues = summarize(cutRun(complete))?.issues ?? [];
      expect(issues.flatMap((issue) => issueMessageStyleProblems(issue.message))).toEqual([]);
      const details = issues.map((issue) => issue.detail ?? "").join("\n");
      const messages = issues.map((issue) => issue.message).join("\n");
      expect(messages).not.toContain(ARCHIVE_PATH);
      expect(details.includes(ARCHIVE_PATH)).toBe(complete !== undefined);
      expect(details.includes("agent_read")).toBe(complete === undefined);
      // A whole saved copy is a usable recovery path, not a warning.
      expect(issues.some((issue) => issue.severity === "warning")).toBe(complete !== true);
    }
  });

  it.each(["compact", "preview"] as const)(
    "shows where the full report is in %s expansion",
    (style) => {
      const tool = withPresentationSettings({ toolCallCollapsedStyle: style }, awaitTool);
      const harness = createToolPresentationHarness(tool, { width: 160 });
      const result = {
        content: [{ type: "text" as const, text: "await output" }],
        details: detailsFor(cutRun(true)),
      };
      const frames = harness.cycle({ runIds: ["agent-1"], until: "all_finished" }, result, {
        states: [false, true, false, true],
      });
      expect(frames.some(({ expanded }) => expanded)).toBe(true);
      for (const { expanded, text } of frames) {
        // Both the issue detail and the report section name the file beside the retained report.
        const mentions = text.replace(/\s+/gu, "").split(ARCHIVE_PATH).length - 1;
        if (expanded) {
          expect(mentions).toBeGreaterThanOrEqual(2);
          expect(text).toContain("finding");
        }
      }
    },
  );

  it("shows a saved report's text and its file in expansion when nothing was cut", () => {
    const tool = withPresentationSettings({ toolCallCollapsedStyle: "compact" }, awaitTool);
    const harness = createToolPresentationHarness(tool, { width: 160 });
    const run = view({
      id: "agent-1",
      name: "reader",
      state: "completed",
      reportGeneration: 1,
      finalText: "Whole retained report.",
      reportArchive: { path: ARCHIVE_PATH, chars: 22, lines: 1, complete: true },
    });
    const frames = harness.cycle(
      { runIds: ["agent-1"], until: "all_finished" },
      { content: [{ type: "text" as const, text: "await output" }], details: detailsFor(run) },
      { states: [false, true] },
    );
    const expanded = frames.filter((frame) => frame.expanded).map((frame) => frame.text);
    expect(expanded.length).toBeGreaterThan(0);
    for (const text of expanded) {
      expect(text).toContain("Whole retained report.");
      expect(text.replace(/\s+/gu, "")).toContain(ARCHIVE_PATH);
    }
  });
});
