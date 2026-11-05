import { createReadToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { stripAnsi } from "pi-cosmic-core";
import { beforeEach, expect, test } from "vitest";
import {
  applyPresentationSettings,
  createToolPresentationHarness,
  expansionOffers,
  expansionTag,
} from "../../testing";
import { isAffordanceRow } from "../../src/preview/affordance-row";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { placeHeadingTag } from "../../src/preview/heading-tag";
import {
  BorderedToolCall,
  renderHiddenPreviewExpandHint,
} from "../../src/preview/bordered-tool-call";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { plainTheme, textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

// A theme that styles every color, so rows carry styling as they do in a terminal.
const styled: Pick<Theme, "fg"> = { fg: (_color, text) => `\u001b[38;5;2m${text}\u001b[39m` };

/** The row's content before its tag, which the tag must never overlap. */
const contentBeforeTag = (row: string) =>
  Fn.pipe(stripAnsi(row), Str.replace(/\s{2,}▸(?: [^▸]+)?$/u, ""));

const compactRow = (summary: CompactSummary, width: number, expandLabel?: string) =>
  renderCompactToolCall(
    { name: "bash", phase: "settled", summary, expandLabel },
    plainTheme,
    width,
  );

test("a collapsed compact row that hides content is one row ending in its tag", () => {
  const summary: CompactSummary = { subject: "pnpm test", outcome: "success" };
  const wide = compactRow(summary, 100, "output");
  expect(wide).toHaveLength(1);
  expect(expansionTag(wide[0] ?? "")).toBe("output");
  expect(visibleWidth(wide[0] ?? "")).toBe(100);
  const narrow = compactRow(summary, 57, "output");
  expect(narrow).toHaveLength(1);
  expect(expansionTag(narrow[0] ?? "")).toBe("");
  // Nothing hidden, no tag.
  expect(expansionOffers(compactRow(summary, 100))).toEqual([]);
});

test("a compact row shortens its subject for the tag and keeps its counter", () => {
  const subject = "cd /Users/someone/dev/project && pnpm vitest run --reporter=dot tests/unit";
  for (const width of [24, 40, 57, 80, 100, 120]) {
    const [row = ""] = compactRow(
      { subject, outcome: "success", counters: ["3 failed"] },
      width,
      "output",
    );
    expect(visibleWidth(row)).toBeLessThanOrEqual(width);
    expect(expansionTag(row)).toBeDefined();
    const content = contentBeforeTag(row);
    expect(Str.startsWith("✓ bash cd")(content)).toBe(true);
    if (width >= 57) expect(Str.endsWith("· 3 failed")(content)).toBe(true);
  }
});

test("a compact row gives up the tag's label before it would lose its counter", () => {
  const [row = ""] = compactRow(
    { subject: "a subject long enough to need cutting", counters: ["12 matching lines"] },
    80,
    "a very long description of what expansion reveals",
  );
  expect(stripAnsi(row)).toContain("12 matching lines");
  expect(expansionTag(row)).toBe("");
});

test("wide glyphs and styling never push a tagged row past its width", () => {
  const rows = [
    "\u001b[1m📖 read\u001b[22m 日本語のファイル名がとても長いパス/設定.ts",
    `${styled.fg("accent", "✓ edit")} ${Fn.pipe("x", Str.repeat(200))}`,
    "short",
  ];
  for (const row of rows)
    for (const width of [4, 10, 57, 80, 100]) {
      const tagged = placeHeadingTag(row, "output", styled, width);
      expect(visibleWidth(tagged)).toBeLessThanOrEqual(width);
      expect(expansionTag(tagged)).toBeDefined();
      // At least two columns separate the content from the tag.
      expect(stripAnsi(tagged)).toMatch(/\S\s{2,}▸(?: output)?$/u);
    }
  // A row narrower than a tag and its gap stays as drawn.
  expect(placeHeadingTag("ab", "output", styled, 3)).toBe("ab");
});

test("a row whose content fills its width is cut by the tag's width", () => {
  const row = Fn.pipe("a", Str.repeat(57));
  const tagged = stripAnsi(placeHeadingTag(row, "output", plainTheme, 57));
  expect(tagged).toBe(`${Fn.pipe("a", Str.repeat(53))}…  ▸`);
});

const shellTool = (summary: (phase: string) => CompactSummary, result: "empty" | "text") =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: () => new Text("Demo call", 0, 0),
      renderResult: (value) =>
        result === "empty"
          ? new Container()
          : new Text(value.content[0]?.type === "text" ? value.content[0].text : "", 0, 0),
    },
    {
      compactSummary: ({ phase }) => summary(phase),
      expandedContent: {
        renderCall: () => new Container(),
        renderResult: () => new Text("Everything retained", 0, 0),
      },
    },
  );

test("a collapsed preview row that hides its result is its heading, ending in the tag", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  for (const [width, label] of [
    [100, "error"],
    [57, ""],
  ] as const) {
    const harness = createToolPresentationHarness(
      shellTool(
        () => ({
          subject: "a.ts",
          outcome: "error",
          issues: [{ severity: "error", code: "x", message: "Couldn't read", detail: "ENOENT" }],
        }),
        "empty",
      ),
    );
    harness.call({ path: "a.ts" });
    harness.result(textResult("ENOENT: no such file"), { isError: true });
    const rows = harness.render(width);
    expect(expansionTag(rows[0] ?? "")).toBe(label);
    expect(expansionOffers(rows)).toEqual([label]);
    expect(Arr.every(rows, (row) => visibleWidth(row) <= width)).toBe(true);
  }
});

test("a preview row whose result decides the tag shows it on the heading, not the timing", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: true });
  const harness = createToolPresentationHarness(
    shellTool(() => ({ subject: "log", outcome: "returned", expandLabel: "log" }), "text"),
    { state: { codePreviewTimingStartedAt: 0, codePreviewTimingEndedAt: 3400 } },
  );
  harness.call({ path: "a.ts" }, { executionStarted: true });
  harness.result(textResult("first\nsecond"));
  const rows = Arr.map(harness.render(100), stripAnsi);
  expect(rows[0]).toMatch(/^Demo call\s{2,}▸ log$/u);
  expect(Arr.some(rows, (row) => Str.includes("Took")(row))).toBe(true);
  expect(expansionOffers(rows)).toEqual(["log"]);
});

test("a preview row that hides nothing draws no tag", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const harness = createToolPresentationHarness(
    shellTool(() => ({ subject: "a.ts", outcome: "success" }), "text"),
  );
  harness.call({ path: "a.ts" });
  harness.result(textResult("all of it"));
  expect(expansionOffers(harness.render(100))).toEqual([]);
});

test("a stand-in is recognized by its separately styled glyph, not by text alone", () => {
  expect(isAffordanceRow(renderExpansionAffordance("7 more lines", false, styled))).toBe(true);
  expect(isAffordanceRow(`  ${renderExpansionAffordance("output", false, styled)}`)).toBe(true);
  // Output whose own text starts with the glyph is styled as one run.
  expect(isAffordanceRow(styled.fg("toolOutput", "▸ step one"))).toBe(false);
  expect(isAffordanceRow(styled.fg("toolOutput", "Demo call"))).toBe(false);
});

const hidingTool = () =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: () => new Text("Demo call", 0, 0),
      renderResult: (_result, _options, theme, context) =>
        renderHiddenPreviewExpandHint(context, theme, "content"),
    },
    { compactSummary: () => ({ subject: "a.ts", outcome: "success" }) },
  );

test("a body's hidden-content hint names the heading's tag instead of drawing a row", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallBackground: "off" });
  const harness = createToolPresentationHarness(hidingTool());
  harness.call({ path: "a.ts" });
  harness.result(textResult("export const a = 1;"));
  const rows = harness.render(100);
  expect(Arr.map(rows, stripAnsi)).toHaveLength(1);
  expect(expansionTag(rows[0] ?? "")).toBe("content");
  // A bordered row names it in its corner.
  applyPresentationSettings({ toolCallBackground: "border" });
  const framed = createToolPresentationHarness(hidingTool());
  framed.call({ path: "a.ts" });
  framed.result(textResult("export const a = 1;"));
  const corner = Arr.findLast(Arr.map(framed.render(100), stripAnsi), (row) =>
    Str.startsWith("╰")(row),
  );
  expect(Option.getOrThrow(corner)).toContain("▸ content");
  expect(expansionOffers(framed.render(100))).toEqual([]);
});

// A bordered row's bottom corner at a width.
const corner = (width: number) => {
  const frame = new BorderedToolCall(plainTheme);
  frame.setContent(new Text("Demo call", 0, 0), undefined, {}, "success", undefined);
  frame.setExpandFallback(() => "proposed edit");
  return stripAnsi(frame.render(width).at(-1) ?? "");
};

test("a bordered row's corner shows a bare ▸ where its label can't fit", () => {
  expect(corner(40)).toMatch(/─ ▸ proposed edit ╯$/u);
  expect(corner(16)).toMatch(/─ ▸ ╯$/u);
  expect(corner(16)).not.toContain("C-o");
});
