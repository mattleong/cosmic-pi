import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { stripAnsi } from "pi-cosmic-core";
import { beforeEach, expect, test } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const LONG = "needs your input";
const SHORT = "needs input";

// The shell captures its mode when wrapping, so each background wraps its own tool.
const tool = () =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: () => new Text("Demo call", 0, 0),
      renderResult: () => new Text("Demo result", 0, 0),
    },
    {
      compactSummary: () => ({
        action: "await",
        subject: "questionnaire",
        counters: [LONG, SHORT],
        outcome: "returned",
      }),
      expandedContent: {
        renderCall: () => new Container(),
        renderResult: () => new Text("Everything retained", 0, 0),
      },
    },
  );

// The heading row and the continuation rows it wraps onto, as one line of words.
const heading = (width: number, expanded: boolean) => {
  const harness = createToolPresentationHarness(tool());
  harness.call({ path: "a.ts" }, { expanded });
  harness.result(textResult("done"), { expanded });
  const rows = Arr.map(harness.render(width), (row) =>
    Fn.pipe(stripAnsi(row), Str.replace(/^\s*│|│\s*$/gu, ""), Str.trim),
  );
  const start = Option.getOrThrow(
    Arr.findFirstIndex(rows, (row) => Fn.pipe(row, Str.includes(" await "))),
  );
  const continued = Arr.takeWhile(Arr.drop(rows, start + 1), (row) =>
    Fn.pipe(row, Str.startsWith("· ")),
  );
  return Arr.join([rows[start] ?? "", ...continued], " ");
};
const counterShown = (row: string) =>
  Fn.pipe(row, Str.includes(`· ${LONG}`))
    ? LONG
    : Fn.pipe(row, Str.includes(`· ${SHORT}`))
      ? SHORT
      : undefined;

for (const background of ["border", "on", "off"] as const)
  test(`an expanded ${background} heading keeps its whole subject and the counter its collapsed row keeps`, () => {
    applyPresentationSettings({ toolCallBackground: background });
    for (const width of Arr.range(36, 48)) {
      const collapsed = counterShown(heading(width, false));
      const expanded = heading(width, true);
      expect(counterShown(expanded), `${width} columns`).toBe(collapsed);
      expect(expanded, `${width} columns`).toContain(" await questionnaire");
    }
    // Some widths keep only the short words, which a frame alone would drop.
    expect(counterShown(heading(40, false))).toBe(SHORT);
  });
