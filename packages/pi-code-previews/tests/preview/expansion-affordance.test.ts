import { beforeEach, expect, test } from "vitest";
import { Container, Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { stripAnsi } from "pi-cosmic-core";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  expansionOffers,
} from "../../testing";
import { withCodePreviewMessageShell } from "../../src/preview/message-shell";
import { authoredTextLines } from "../../src/preview/authored-text";
import { wrapPreviewHeading } from "../../src/preview/heading-wrap";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { customMessage, demoShellTool, drawMessage, textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const styles = ["compact", "preview"] as const;
const affordances = (text: string) => expansionOffers(Str.split(text, "\n"));

const tool = (
  summary: (phase: string) => CompactSummary,
  options: { readonly result?: "empty" | "clipped" | "text" } = {},
) =>
  demoShellTool(summary, {
    result: (result, _options, theme) => {
      if (options.result === "empty") return new Container();
      const clipped = `first\n${renderExpansionAffordance("2 more lines", false, theme)}`;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      return new Text(options.result === "clipped" ? clipped : text, 0, 0);
    },
  });

for (const style of styles)
  test.each([
    ["checks", ["checks"]],
    [false, []],
  ] as const)(`expandLabel %j offers %j in ${style} style`, (expandLabel, offers) => {
    applyPresentationSettings({ toolCallCollapsedStyle: style });
    const harness = createToolPresentationHarness(
      tool(() => ({ subject: "check", outcome: "returned", expandLabel }), { result: "empty" }),
    );
    harness.call({ path: "a.ts" });
    harness.result(textResult("12 checks passed"));
    const shown = affordances(Arr.join(harness.render(), "\n"));
    expect(shown).toHaveLength(offers.length);
    for (const [index, label] of offers.entries()) expect(shown[index]).toContain(label);
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
      const took = Arr.findFirstIndex(rows, (row) => Fn.pipe(row, Str.includes("Took")));
      const hint = Arr.findFirstIndex(rows, (row) => Fn.pipe(Str.trim(row), Str.startsWith("▸ ")));
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
  expect(
    Fn.pipe(
      text,
      Str.match(/⚠/gu),
      Option.map((found) => found.length),
    ),
  ).toEqual(Option.some(1));
});

const heldTool = (summary: (phase: string) => CompactSummary, body: string) =>
  demoShellTool(summary, {
    result: () => new Text(body, 0, 0),
    expandedResult: () => new Text(body, 0, 0),
  });

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
    return affordances(Arr.join(harness.render(), "\n"));
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
    (row) => Fn.pipe(Str.trim(row), Str.startsWith("╰")),
  );
  expect(Option.getOrThrow(corner)).toContain("checks");
});

const note = (content: string) =>
  withCodePreviewMessageShell((_message, _options, theme) => ({
    name: "note",
    summary: { subject: "notes", outcome: "returned" },
    collapsed: () => ({
      render: (width) => authoredTextLines(content, width, theme, { expanded: false }),
      invalidate: () => undefined,
    }),
    expandLabel: "message",
  }));

test.each(styles)("a message's expandLabel is offered once in %s style", (style) => {
  applyPresentationSettings({ toolCallCollapsedStyle: style });
  const long = Arr.join(
    Arr.map(Arr.range(1, 20), (line) => `Line ${line}`),
    "\n",
  );
  for (const content of [
    "Short note",
    // Clipped words end in their own affordance, so the label isn't added again.
    long,
  ])
    expect(
      affordances(Arr.join(drawMessage(note(content), false, customMessage({ content })), "\n")),
    ).toHaveLength(1);
});

const withoutSpaces = (text: string) => Fn.pipe(text, Str.replace(/\s+/gu, ""));

test("a wrapped preview heading keeps every character, hangs, and never ends a row with a separator", () => {
  const heading =
    "📖 read packages/pi-code-previews/src/tools/renderers/shared/builtin-expanded-content.ts:1-2 · typescript";
  for (const width of [57, 100]) {
    const rows = Arr.map(wrapPreviewHeading(heading, width), stripAnsi);
    expect(rows.length).toBeGreaterThan(1);
    expect(withoutSpaces(Arr.join(rows, ""))).toBe(withoutSpaces(heading));
    Arr.forEach(rows, (row, index) => {
      expect(Fn.pipe(Str.trimEnd(row), Str.endsWith("·"))).toBe(false);
      // Facts stay whole, and continuation rows hang beneath the heading.
      expect(Fn.pipe(row, Str.includes("typescript")) || !Fn.pipe(row, Str.includes("typ"))).toBe(
        true,
      );
      if (index > 0) expect(Fn.pipe(row, Str.startsWith("  "))).toBe(true);
    });
  }
});

test("a wrapped heading keeps a fact with a path whole when it fits on a row", () => {
  const heading = "✓ agent_profiles reviewer · openai-codex/gpt-5.6-sol:high";
  for (const width of [40, 50]) {
    const rows = Arr.map(wrapPreviewHeading(heading, width), (row) => Str.trim(stripAnsi(row)));
    expect(rows).toContain("· openai-codex/gpt-5.6-sol:high");
  }
});

test.each([
  ["Startup is faster because the parser loads lazily, and bundles are smaller.", 0],
  ["Nothing about the answer here", 1],
] as const)(
  "an expanded preview row keeps a cut fact its body doesn't state whole, with body %j",
  (whole, lines) => {
    applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
    const cut = "“Startup is faster because the parser loads…”";
    const harness = createToolPresentationHarness(
      demoShellTool(
        (phase) => ({
          subject: "Summary",
          metadata: [cut],
          ...(phase === "settled" && { outcome: "success" }),
        }),
        {
          result: () => new Text(`Summary: ${cut}`, 0, 0),
          expandedResult: () => new Text(`Summary: ${whole}`, 0, 0),
        },
      ),
    );
    harness.call({ path: "a.ts" }, { expanded: true });
    harness.result(textResult(whole), { expanded: true });
    // At 57 columns the whole answer wraps across rows, which still state the cut words.
    const rows = Str.split(stripAnsi(Arr.join(harness.render(57), "\n")), "\n");
    expect(Arr.filter(rows, (row) => Fn.pipe(row, Str.includes(cut)))).toHaveLength(lines);
  },
);
