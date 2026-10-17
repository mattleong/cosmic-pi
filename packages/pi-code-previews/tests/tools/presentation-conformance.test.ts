import { beforeEach, expect, test } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import {
  withCodePreviewShell,
  type CodePreviewShellOptions,
} from "../../src/tools/cooperative-tools";
import type { CompactIssue } from "../../src/tools/compact-issues";
import { failingRenderer, textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);
const modes = ["on", "off", "border"] as const;
const result = textResult("RAW diagnostics");
const issue: CompactIssue = {
  severity: "error",
  code: "failure",
  message: "Failure cause",
  detail: "Independent recovery",
};
const count = (text: string, phrase: string) => text.split(phrase).length - 1;
const inOrder = (text: string, phrases: readonly string[]) => {
  const positions = phrases.map((phrase) => text.indexOf(phrase));
  return positions.every((position, index) => position >= (positions[index - 1] ?? 0));
};
const textRenderer = (label: string) => () => new Text(label, 0, 0);
const readShell = (
  renderCall: () => Component,
  renderResult: () => Component,
  options: CodePreviewShellOptions,
) =>
  withCodePreviewShell(
    { ...createReadToolDefinition("/project"), renderCall, renderResult },
    options,
  );

test.each(modes)(
  "content callbacks follow the heading and issues, with every issue once, in %s mode",
  (mode) => {
    const original = {
      content: [{ type: "text" as const, text: "RAW diagnostics\nAGENT_COMMAND retry" }],
      details: undefined,
    };
    const before = JSON.stringify(original);
    const source = createReadToolDefinition("/project");
    let executions = 0;
    const tool = withCodePreviewShell(
      {
        ...source,
        execute: (...args: Parameters<typeof source.execute>) => {
          executions++;
          return source.execute(...args);
        },
        renderCall: () => new Text("ORIGINAL CALL", 0, 0),
        renderResult: () => new Text("ORIGINAL RESULT", 0, 0),
      },
      {
        mode,
        compactSummary: () => ({
          subject: "FULL_INTERNAL_SUBJECT",
          compactSubject: "Operation",
          outcome: "warning",
          issues: [
            {
              severity: "warning",
              code: "unconfirmed",
              message: "The operation may still be running",
              detail: "AGENT_DETAIL inspect status before retry",
            },
            { severity: "info", code: "page", message: "INFO_NOTE more pages" },
          ],
        }),
        expandedContent: {
          renderCall: () => new Text("CONTENT CALL", 0, 0),
          renderResult: () => new Text("CONTENT RESULT", 0, 0),
        },
      },
    );
    const h = createToolPresentationHarness(tool, { width: 120 });
    for (const { expanded, text } of h.cycle({ path: "file" }, original)) {
      expect(count(text, "The operation may still be running")).toBe(1);
      for (const phrase of ["AGENT_DETAIL", "INFO_NOTE", "CONTENT CALL", "CONTENT RESULT"])
        expect(count(text, phrase)).toBe(expanded ? 1 : 0);
      expect(text).not.toMatch(/ORIGINAL CALL|ORIGINAL RESULT|RAW diagnostics|AGENT_COMMAND/u);
      expect(text.includes("FULL_INTERNAL_SUBJECT")).toBe(expanded);
      expect(text.includes("Operation")).toBe(!expanded);
      const expandedOrder = [
        "FULL_INTERNAL_SUBJECT",
        "The operation may still be running",
        "AGENT_DETAIL",
        "INFO_NOTE",
        "CONTENT CALL",
        "CONTENT RESULT",
      ];
      expect(inOrder(text, expandedOrder)).toBe(expanded);
      expect(JSON.stringify(original)).toBe(before);
    }
    expect(executions).toBe(0);
  },
);

test("content construction or drawing failure falls back in that slot and keeps issues once", () => {
  for (const failure of ["none", "factory", "draw"] as const) {
    const tool = readShell(textRenderer("ORIGINAL CALL"), textRenderer("ORIGINAL RESULT"), {
      mode: "off",
      compactSummary: () => ({
        subject: "read result",
        outcome: "error",
        issues: [issue, { severity: "info", code: "page", message: "Continue with next page" }],
      }),
      expandedContent: {
        renderCall: textRenderer("unique call"),
        renderResult: failingRenderer(failure, ["content output"]),
      },
    });
    const h = createToolPresentationHarness(tool);
    h.call({ path: "file" }, { expanded: true });
    h.result(result, { expanded: true });
    for (let redraw = 0; redraw < 2; redraw++) {
      const text = h.render().join("\n");
      expect(text).toContain("unique call");
      for (const phrase of ["Failure cause", "Independent recovery", "Continue with next page"])
        expect(count(text, phrase)).toBe(1);
      expect(text).not.toMatch(/ORIGINAL/u);
      expect(text.includes("content output")).toBe(failure === "none");
      expect(text.includes("RAW diagnostics")).toBe(failure !== "none");
    }
  }
});
