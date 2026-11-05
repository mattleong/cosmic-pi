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

const heading = (width: number, expanded: boolean) => {
  const harness = createToolPresentationHarness(tool());
  harness.call({ path: "a.ts" }, { expanded });
  harness.result(textResult("done"), { expanded });
  return Option.getOrThrow(
    Arr.findFirst(Arr.map(harness.render(width), stripAnsi), (row) =>
      Fn.pipe(row, Str.includes(" await ")),
    ),
  );
};
const counterShown = (row: string) =>
  Fn.pipe(row, Str.includes(`· ${LONG}`))
    ? LONG
    : Fn.pipe(row, Str.includes(`· ${SHORT}`))
      ? SHORT
      : undefined;

for (const background of ["border", "on", "off"] as const)
  test(`an expanded ${background} heading keeps the counter its collapsed row keeps`, () => {
    applyPresentationSettings({ toolCallBackground: background });
    for (const width of Arr.range(36, 48)) {
      const collapsed = counterShown(heading(width, false));
      expect(counterShown(heading(width, true)), `${width} columns`).toBe(collapsed);
    }
    // Some widths keep only the short words, which a frame alone would drop.
    expect(counterShown(heading(40, false))).toBe(SHORT);
  });
