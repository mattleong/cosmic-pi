import {
  applyPresentationSettings,
  createToolPresentationHarness,
  withPresentationSettings,
} from "pi-code-previews/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SubagentRunView } from "../../src/run/model.ts";
import { MAX_FINAL_TEXT_CHARS } from "../../src/run/state.ts";
import { SUBAGENT_TOOL_NAME } from "../../src/run/tool-policy.ts";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { decodeStartAwaitCardDetails } from "../../src/tools/details-decode.ts";
import { awaitDetails } from "../../src/tools/details.ts";
import { issueStyle, renderOnlyTool, settledSummary, view } from "./fixtures/tool-harness.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";

const ARCHIVE_PATH = "/agent/subagents/reports/session-1/agent-1-1-archive.md";

const cutRun = (complete: boolean | undefined): SubagentRunView =>
  view({
    id: "agent-1",
    name: "reader",
    state: "completed",
    reportGeneration: 1,
    finalText: `${Fn.pipe("finding\n", Str.repeat(MAX_FINAL_TEXT_CHARS / 8 - 1))}end`,
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
  settledSummary(
    createSubagentCompactSummary(SUBAGENT_TOOL_NAME.await),
    { runIds: [run.id], until: "all_finished" },
    { details: detailsFor(run), text: "await output" },
  );

const awaitTool = () => renderOnlyTool(SUBAGENT_TOOL_NAME.await);

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

  it("states a cut report's retention in its issue, leaving the saved file to Details", () => {
    for (const complete of [true, false, undefined]) {
      const summary = summarize(cutRun(complete));
      const issues = summary?.issues ?? [];
      expect(issueStyle(summary)).toEqual([]);
      const details = Arr.join(
        Arr.map(issues, (issue) => issue.detail ?? ""),
        "\n",
      );
      const messages = Arr.join(
        Arr.map(issues, (issue) => issue.message),
        "\n",
      );
      expect(messages).not.toContain(ARCHIVE_PATH);
      // Details name the file and its size, so the issue never repeats them.
      expect(details).not.toContain(ARCHIVE_PATH);
      expect(details).not.toMatch(/\bagent_[a-z]+\b/u);
      // A whole saved copy is a usable recovery path, not a warning.
      expect(Arr.some(issues, (issue) => issue.severity === "warning")).toBe(complete !== true);
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
      for (const { expanded, text } of frames) {
        // Details name the file once beside the retained report; the issue doesn't repeat it.
        const mentions =
          Str.split(Fn.pipe(text, Str.replace(/\s+/gu, "")), ARCHIVE_PATH).length - 1;
        if (expanded) {
          expect(mentions).toBe(1);
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
    const expanded = Arr.map(
      Arr.filter(frames, (frame) => frame.expanded),
      (frame) => frame.text,
    );
    expect(expanded.length).toBeGreaterThan(0);
    for (const text of expanded) {
      expect(text).toContain("Whole retained report.");
      expect(Fn.pipe(text, Str.replace(/\s+/gu, ""))).toContain(ARCHIVE_PATH);
    }
  });
});
