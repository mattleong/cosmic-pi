import { beforeEach, expect, test } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { stripAnsi } from "pi-cosmic-core";
import { keybindingHintsFixture, plainTheme } from "pi-cosmic-core/testing";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { withCodePreviewMessageShell } from "../../src/preview/message-shell";
import { authoredTextLines } from "../../src/preview/authored-text";
import { wrapPreviewHeading } from "../../src/preview/heading-wrap";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const styles = ["compact", "preview"] as const;
const affordances = (text: string) =>
  Arr.filter(Str.split(stripAnsi(text), "\n"), (row) => Str.startsWith("▸ ")(Str.trim(row)));

const tool = (
  summary: (phase: string) => CompactSummary,
  options: { readonly result?: "empty" | "clipped" | "text" } = {},
) =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: () => new Text("Demo call", 0, 0),
      renderResult: (result, _options, theme) => {
        if (options.result === "empty") return new Container();
        const clipped = `first\n${renderExpansionAffordance("2 more lines", false, theme)}`;
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(options.result === "clipped" ? clipped : text, 0, 0);
      },
    },
    {
      compactSummary: ({ phase }) => summary(phase),
      expandedContent: {
        renderCall: () => new Container(),
        renderResult: () => new Text("Everything retained", 0, 0),
      },
    },
  );

test.each(styles)("a declared expandLabel is offered once in %s style", (style) => {
  applyPresentationSettings({ toolCallCollapsedStyle: style });
  const harness = createToolPresentationHarness(
    tool(() => ({ subject: "check", outcome: "returned", expandLabel: "checks" }), {
      result: "empty",
    }),
  );
  harness.call({ path: "a.ts" });
  harness.result(textResult("12 checks passed"));
  const shown = affordances(Arr.join(harness.render(), "\n"));
  expect(shown).toHaveLength(1);
  expect(shown[0]).toContain("checks");
});

test.each(styles)("expandLabel false offers no expansion in %s style", (style) => {
  applyPresentationSettings({ toolCallCollapsedStyle: style });
  const harness = createToolPresentationHarness(
    tool(() => ({ subject: "check", outcome: "returned", expandLabel: false }), {
      result: "empty",
    }),
  );
  harness.call({ path: "a.ts" });
  harness.result(textResult("12 checks passed"));
  expect(affordances(Arr.join(harness.render(), "\n"))).toHaveLength(0);
});

test("an empty partial result keeps a compact call's expansion", () => {
  const harness = createToolPresentationHarness(tool(() => ({ subject: "question" })));
  harness.call({ path: "a.ts" }, { executionStarted: true, isPartial: true });
  harness.result(textResult(""), { isPartial: true });
  expect(affordances(Arr.join(harness.render(), "\n"))).toHaveLength(1);
});

test.each(styles)(
  "a collapsed body's own affordance isn't repeated and closes the row after timing in %s style",
  (style) => {
    applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: true });
    const harness = createToolPresentationHarness(
      tool(() => ({ subject: "log", outcome: "returned", expandLabel: "log" }), {
        result: "clipped",
      }),
      { state: { codePreviewTimingStartedAt: 0, codePreviewTimingEndedAt: 3400 } },
    );
    harness.call({ path: "a.ts" }, { executionStarted: true });
    harness.result(textResult("first\nsecond\nthird"));
    const rows = Str.split(stripAnsi(Arr.join(harness.render(), "\n")), "\n");
    expect(affordances(Arr.join(rows, "\n"))).toHaveLength(1);
    if (style === "preview") {
      const took = Arr.findFirstIndex(rows, (row) => Str.includes("Took")(row));
      const hint = Arr.findFirstIndex(rows, (row) => Str.startsWith("▸ ")(Str.trim(row)));
      expect(Option.getOrThrow(took)).toBeLessThan(Option.getOrThrow(hint));
    }
  },
);

test("an expanded preview row whose issues state its state draws no state line", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const harness = createToolPresentationHarness(
    tool((phase) => ({
      subject: "notes",
      metadata: ["received"],
      messageIcon: "received",
      issues: [{ severity: "warning", code: "demo", message: "Docker isn't running" }],
      ...(phase === "settled" && { outcome: "warning" }),
    })),
  );
  harness.call({ path: "a.ts" }, { expanded: true });
  harness.result(textResult("received\nnotes ready"), { expanded: true });
  const text = stripAnsi(Arr.join(harness.render(), "\n"));
  expect(text).toContain("Docker isn't running");
  expect(Str.match(/⚠/gu)(text).pipe(Option.map((found) => found.length))).toEqual(Option.some(1));
});

const heldTool = (summary: (phase: string) => CompactSummary, body: string) =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: () => new Text("Demo call", 0, 0),
      renderResult: () => new Text(body, 0, 0),
    },
    {
      compactSummary: ({ phase }) => summary(phase),
      expandedContent: {
        renderCall: () => new Container(),
        renderResult: () => new Text(body, 0, 0),
      },
    },
  );

test.each([
  ["paused", "Reviewed 3 of 7 files", 1],
  ["paused", "0/1 finished · 1 paused\n‖ auth-review · paused", 0],
  ["paused", "The review paused twice before", 1],
  ["paused", "Paused by the user", 0],
  ["running", "The dev server keeps running on port 5173", 1],
  ["running", "0/2 finished · 2 running", 0],
  // A running call nested in a section states its own state, not the row's.
  ["running", "  Calls\n    ⠋ read source.ts", 1],
] as const)(
  "an expanded preview %s row states its state once with body %j",
  (state, body, lines) => {
    applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
    const harness = createToolPresentationHarness(
      heldTool(
        (phase) => ({
          subject: "review",
          ...(phase === "settled" && state === "paused" && { outcome: "paused" }),
        }),
        body,
      ),
    );
    harness.call({ path: "a.ts" }, { expanded: true, executionStarted: true });
    if (state === "paused") harness.result(textResult(body), { expanded: true });
    else harness.result(textResult(body), { expanded: true, isPartial: true });
    const text = stripAnsi(Arr.join(harness.render(), "\n"));
    // The line appears exactly when no body row already states the state.
    const stateLines = Arr.filter(Str.split(text, "\n"), (row) =>
      /^\S+ (?:Paused|Running…)$/u.test(Str.trim(row)),
    );
    expect(stateLines).toHaveLength(lines);
  },
);

test("an expanded waiting preview row states the words its compact heading shows", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const harness = createToolPresentationHarness(
    heldTool(
      () => ({ subject: "release", waiting: true, counters: ["needs your input"] }),
      "Asked 4 questions",
    ),
  );
  harness.call({ path: "a.ts" }, { expanded: true, executionStarted: true });
  harness.result(textResult("Asked 4 questions"), { expanded: true, isPartial: true });
  const text = Str.toLowerCase(stripAnsi(Arr.join(harness.render(), "\n")));
  expect(text).toContain("needs your input");
  expect(text).not.toContain("waiting for reply");
});

const failedRead = (phase: string): CompactSummary => ({
  subject: "a.ts",
  issues: [{ severity: "error", code: "demo", message: "Couldn't read", detail: "ENOENT" }],
  ...(phase === "settled" && { outcome: "error" }),
});

test("a failure the collapsed preview body leaves out offers its error, as compact does", () => {
  const labels = Arr.map(styles, (style) => {
    applyPresentationSettings({ toolCallCollapsedStyle: style });
    const harness = createToolPresentationHarness(tool(failedRead, { result: "empty" }));
    harness.call({ path: "a.ts" });
    harness.result(textResult("ENOENT: no such file"), { isError: true });
    return Arr.map(affordances(Arr.join(harness.render(), "\n")), Str.trim);
  });
  expect(labels[0]).toHaveLength(1);
  expect(labels[1]).toEqual(labels[0]);
});

test("a bordered preview row names what expansion reveals in its corner", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallBackground: "border" });
  const harness = createToolPresentationHarness(
    tool(() => ({ subject: "check", outcome: "returned", expandLabel: "checks" }), {
      result: "empty",
    }),
  );
  harness.call({ path: "a.ts" });
  harness.result(textResult("12 checks passed"));
  const corner = Arr.findFirst(
    Str.split(stripAnsi(Arr.join(harness.render(), "\n")), "\n"),
    (row) => Str.startsWith("╰")(Str.trim(row)),
  );
  expect(Option.getOrThrow(corner)).toContain("checks");
});

const renderNote = (content: string) =>
  withCodePreviewMessageShell((_message, _options, theme) => ({
    name: "note",
    summary: { subject: "notes", outcome: "returned" },
    collapsed: () => ({
      render: (width) => authoredTextLines(content, width, theme, { expanded: false }),
      invalidate: () => undefined,
    }),
    expandLabel: "message",
  }))(
    { role: "custom", customType: "note", content, display: true, timestamp: 0 },
    { ...keybindingHintsFixture, expanded: false, outputPad: 1 },
    plainTheme,
  );

test.each(styles)("a message's expandLabel is offered once in %s style", (style) => {
  applyPresentationSettings({ toolCallCollapsedStyle: style });
  const long = Arr.join(
    Arr.map(Arr.range(1, 20), (line) => `Line ${line}`),
    "\n",
  );
  expect(affordances(Arr.join(renderNote("Short note").render(80), "\n"))).toHaveLength(1);
  // Clipped words end in their own affordance, so the label isn't added again.
  expect(affordances(Arr.join(renderNote(long).render(80), "\n"))).toHaveLength(1);
});

const withoutSpaces = (text: string) => Str.replace(/\s+/gu, "")(text);

test("a wrapped preview heading keeps every character, hangs, and never ends a row with a separator", () => {
  const heading =
    "📖 read packages/pi-code-previews/src/tools/renderers/shared/builtin-expanded-content.ts:1-2 · typescript";
  for (const width of [57, 100]) {
    const rows = Arr.map(wrapPreviewHeading(heading, width), stripAnsi);
    expect(rows.length).toBeGreaterThan(1);
    expect(withoutSpaces(Arr.join(rows, ""))).toBe(withoutSpaces(heading));
    Arr.forEach(rows, (row, index) => {
      expect(Str.endsWith("·")(Str.trimEnd(row))).toBe(false);
      // Facts stay whole, and continuation rows hang beneath the heading.
      expect(Str.includes("typescript")(row) || !Str.includes("typ")(row)).toBe(true);
      if (index > 0) expect(Str.startsWith("  ")(row)).toBe(true);
    });
  }
});
