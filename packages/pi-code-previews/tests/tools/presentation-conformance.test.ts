import { beforeEach, expect, test } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import type { CompactIssue } from "../../src/tools/compact-issues";
import { failingRenderer, occurrences, textResult } from "../support/render";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";

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
const inOrder = (text: string, phrases: readonly string[]) => {
  const positions = Arr.map(phrases, (phrase) =>
    Option.getOrElse(Fn.pipe(text, Str.indexOf(phrase)), () => -1),
  );
  return Arr.every(positions, (position, index) => position >= (positions[index - 1] ?? 0));
};
const textRenderer = (label: string) => () => new Text(label, 0, 0);

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
      expect(occurrences(text, "The operation may still be running")).toBe(1);
      for (const phrase of ["AGENT_DETAIL", "INFO_NOTE", "CONTENT CALL", "CONTENT RESULT"])
        expect(occurrences(text, phrase)).toBe(expanded ? 1 : 0);
      expect(text).not.toMatch(/ORIGINAL CALL|ORIGINAL RESULT|RAW diagnostics|AGENT_COMMAND/u);
      expect(Fn.pipe(text, Str.includes("FULL_INTERNAL_SUBJECT"))).toBe(expanded);
      expect(Fn.pipe(text, Str.includes("Operation"))).toBe(!expanded);
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
    const definition = {
      ...createReadToolDefinition("/project"),
      renderCall: textRenderer("ORIGINAL CALL"),
      renderResult: textRenderer("ORIGINAL RESULT"),
    };
    const tool = withCodePreviewShell(definition, {
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
      const text = Arr.join(h.render(), "\n");
      expect(text).toContain("unique call");
      for (const phrase of ["Failure cause", "Independent recovery", "Continue with next page"])
        expect(occurrences(text, phrase)).toBe(1);
      expect(text).not.toMatch(/ORIGINAL/u);
      expect(Fn.pipe(text, Str.includes("content output"))).toBe(failure === "none");
      expect(Fn.pipe(text, Str.includes("RAW diagnostics"))).toBe(failure !== "none");
    }
  }
});

test.each(modes)(
  "an expanded preview row keeps the state its collapsed preview shows, once, in %s mode",
  (mode) => {
    applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false });
    const preview = (
      collapsedResult: string,
      expandedResult: string,
      summary: { readonly counters?: readonly string[]; readonly metadata?: readonly string[] },
    ) =>
      createToolPresentationHarness(
        withCodePreviewShell(
          {
            ...createReadToolDefinition("/project"),
            renderCall: textRenderer("Task status"),
            renderResult: textRenderer(collapsedResult),
          },
          {
            mode,
            compactSummary: ({ phase }) => ({
              subject: "server",
              ...summary,
              ...(phase === "settled" && { outcome: "returned" as const }),
            }),
            expandedContent: {
              renderCall: textRenderer("Command pnpm dev"),
              renderResult: textRenderer(expandedResult),
            },
          },
        ),
        { width: 120 },
      );
    const states = (h: ReturnType<typeof preview>, state: RegExp) =>
      Arr.map(h.cycle({ path: "file" }, result), ({ expanded, text }) => ({
        expanded,
        count: Option.match(Fn.pipe(Str.toLowerCase(text), Str.match(state)), {
          onNone: () => 0,
          onSome: (found) => found.length,
        }),
      }));

    // Content-only bodies leave the state to the heading, which a preview heading doesn't show.
    for (const { count: shown } of states(
      preview("running · pnpm dev", "Output ready in 412 ms", { metadata: ["running"] }),
      /\brunning\b/gu,
    ))
      expect(shown).toBe(1);
    // A body that states it already isn't repeated.
    for (const { count: shown } of states(
      preview("running · pnpm dev", "State running", { metadata: ["running"] }),
      /\brunning\b/gu,
    ))
      expect(shown).toBe(1);
    // A fact the collapsed preview never showed isn't added on expansion.
    for (const { expanded, count: shown } of states(
      preview("No active tasks", "No active tasks", { counters: ["0 tasks"] }),
      /\b0 tasks\b/gu,
    ))
      expect({ expanded, shown }).toEqual({ expanded, shown: 0 });
  },
);
