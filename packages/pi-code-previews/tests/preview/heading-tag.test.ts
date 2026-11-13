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
import { previewHeadingText } from "../../src/preview/heading-wrap";
import {
  BorderedToolCall,
  renderHiddenPreviewExpandHint,
} from "../../src/preview/bordered-tool-call";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { demoShellTool, plainTheme, textResult } from "../support/render";

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
    expect(Fn.pipe(content, Str.startsWith("✓ bash cd"))).toBe(true);
    if (width >= 57) expect(Fn.pipe(content, Str.endsWith("· 3 failed"))).toBe(true);
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

test("the label never costs a compact row any of its subject or counter", () => {
  // Beside a bare ▸ this subject and its widest counter fit at 100 columns; beside the label they don't.
  const subject = Fn.pipe(
    "Deployment environment, Rollback plan, Release notes",
    Str.padEnd(60, "."),
  );
  const counters = ["3 answers · Blue/green", "3 answers"];
  const [row = ""] = compactRow({ subject, outcome: "success", counters }, 100, "questions");
  expect(contentBeforeTag(row)).toBe(`✓ bash ${subject} · 3 answers · Blue/green`);
  expect(expansionTag(row)).toBe("");
  // Where the label leaves the same row, it shows.
  const [short = ""] = compactRow(
    { subject: "Rollback plan", outcome: "success", counters },
    100,
    "questions",
  );
  expect(contentBeforeTag(short)).toBe("✓ bash Rollback plan · 3 answers · Blue/green");
  expect(expansionTag(short)).toBe("questions");
});

test("a bare tag shortens the subject further before it would drop the first fact", () => {
  for (const counters of [["2 answers"], ["2 answers · delivered", "2 answers"]]) {
    const input = {
      name: "ask_user_async_control",
      phase: "settled" as const,
      summary: {
        subject: "Environment, Library",
        action: "await",
        outcome: "success" as const,
        counters,
      },
    };
    const untagged = stripAnsi(renderCompactToolCall(input, plainTheme, 57)[0] ?? "");
    expect(untagged).toContain("· 2 answers");
    const [row = ""] = renderCompactToolCall({ ...input, expandLabel: "answers" }, plainTheme, 57);
    expect(expansionTag(row)).toBe("");
    expect(contentBeforeTag(row)).toMatch(/^✓ ask_user_async_control await Env\S*… · 2 answers$/u);
  }
});

test("a row too narrow for its tool name beside a tag draws no tag", () => {
  const [row = ""] = renderCompactToolCall(
    {
      name: "status_demo",
      phase: "settled",
      summary: { subject: "Search", outcome: "returned" },
      expandLabel: "output",
    },
    plainTheme,
    16,
  );
  expect(stripAnsi(row)).toMatch(/^• status_demo S…$/u);
  expect(expansionOffers([row])).toEqual([]);
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

const shellTool = (summary: (phase: string) => CompactSummary, result: "empty" | "text") =>
  demoShellTool(summary, {
    result: (value) =>
      result === "empty"
        ? new Container()
        : new Text(value.content[0]?.type === "text" ? value.content[0].text : "", 0, 0),
  });

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
  expect(Arr.some(rows, (row) => Fn.pipe(row, Str.includes("Took")))).toBe(true);
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

// A heading one column narrower than a 57-column row: it fits the row, but not beside a tag.
const nearWidthHeading = "Demo call reading packages/pi-code-previews/src/a.ts mar";

const headingTool = (
  result: "hidden" | "empty" | "text",
  options: { readonly standIn?: true; readonly draws?: { count: number } } = {},
) =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: (_args, theme) => {
        const call = new Container();
        call.addChild(previewHeadingText(() => nearWidthHeading));
        if (options.standIn)
          call.addChild(new Text(renderExpansionAffordance("3 more lines", false, theme), 0, 0));
        return call;
      },
      renderResult: (_result, _options, theme, context) => {
        if (result === "hidden") return renderHiddenPreviewExpandHint(context, theme, "content");
        if (result === "empty") return new Container();
        const { draws } = options;
        return {
          render: () => {
            if (draws) draws.count += 1;
            return ["all of it"];
          },
          invalidate: () => undefined,
        };
      },
    },
    { compactSummary: () => ({ subject: "a.ts", outcome: "success" }) },
  );

const drawRow = (tool: ReturnType<typeof headingTool>, width = 57) => {
  const harness = createToolPresentationHarness(tool);
  harness.call({ path: "a.ts" });
  harness.result(textResult("export const a = 1;"));
  return harness.render(width);
};

test("a preview heading that fits its row but not beside the tag wraps rather than being cut", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallBackground: "off" });
  expect(visibleWidth(nearWidthHeading)).toBe(56);
  const rows = Arr.map(drawRow(headingTool("hidden")), stripAnsi);
  expect(rows).toHaveLength(2);
  expect(expansionTag(rows[0] ?? "")).toBe("");
  expect(Arr.some(rows, (row) => Fn.pipe(row, Str.includes("…")))).toBe(false);
  expect(
    Arr.join(
      Arr.map(rows, (row) => Str.trim(contentBeforeTag(row))),
      " ",
    ),
  ).toBe(nearWidthHeading);
});

test("a preview heading keeps no room for a tag the row doesn't draw", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallBackground: "off" });
  // The result alone calls for a tag; the call's own stand-in then withdraws it.
  const withdrawn = Arr.map(drawRow(headingTool("empty", { standIn: true })), stripAnsi);
  expect(expansionOffers(withdrawn)).toEqual(["3 more lines"]);
  expect(Str.trimEnd(withdrawn[0] ?? "")).toBe(nearWidthHeading);
  // A result the row shows calls for none.
  const shown = Arr.map(drawRow(headingTool("text")), stripAnsi);
  expect(expansionOffers(shown)).toEqual([]);
  expect(Str.trimEnd(shown[0] ?? "")).toBe(nearWidthHeading);
});

test("a collapsed preview row draws its result body once per frame", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallBackground: "off" });
  const draws = { count: 0 };
  const harness = createToolPresentationHarness(headingTool("text", { draws }));
  harness.call({ path: "a.ts" });
  harness.result(textResult("export const a = 1;"));
  for (const frame of [1, 2, 3]) {
    expect(Arr.map(harness.render(57), stripAnsi)).toContain("all of it");
    expect(draws.count).toBe(frame);
  }
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
    Fn.pipe(row, Str.startsWith("╰")),
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
});
