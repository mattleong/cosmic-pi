import { beforeEach, expect, test } from "vitest";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { stripAnsi } from "pi-cosmic-core";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { headingShowedSubject } from "../../src/preview/heading-coverage";
import { previewHeadingText } from "../../src/preview/heading-wrap";
import { textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const SUBJECT = "a watercolor otter reading a newspaper on a riverbank at dawn";
const FALLBACK = "SUBJECT AGAIN";

// The body leaves the subject out only when the heading reports it showed the subject whole.
const subjectBody = (state: WeakKey): Component => ({
  render: () => (headingShowedSubject(state) ? ["BODY"] : ["BODY", FALLBACK]),
  invalidate: () => undefined,
});

const tool = (heading: (width: number) => string[]) =>
  withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderCall: () => ({ render: heading, invalidate: () => undefined }),
      renderResult: () => new Text("done", 0, 0),
    },
    {
      compactSummary: () => ({ action: "draw", subject: SUBJECT, outcome: "success" }),
      expandedContent: {
        renderCall: (_args, _theme, context) => subjectBody(context.state),
        renderResult: () => new Text("Everything retained", 0, 0),
      },
    },
  );

const expandedText = (heading: (width: number) => string[], width: number) => {
  const harness = createToolPresentationHarness(tool(heading));
  harness.call({ path: "a.ts" }, { expanded: true });
  harness.result(textResult("done"), { expanded: true });
  return stripAnsi(Arr.join(harness.render(width), "\n"));
};

const clippedHeading = (width: number) => [clipToWidth(`Image ${SUBJECT}`, width - 4)];
const wholeHeading = (width: number) =>
  Arr.map(Arr.chunksOf(Str.split(`Image ${SUBJECT}`, " "), 4), (words) =>
    clipToWidth(Arr.join(words, " "), width),
  );

test("a preview heading that ends in an ellipsis keeps the body's copy of the subject", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const text = expandedText(clippedHeading, 57);
  expect(text).toContain("…");
  expect(text).toContain(FALLBACK);
});

test("a preview heading that shows the subject whole lets the body leave it out", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const text = expandedText(wholeHeading, 57);
  expect(text).toContain("BODY");
  expect(text).not.toContain(FALLBACK);
});

test("a compact heading reports the subject whole only where it wraps it uncut", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
  expect(expandedText(clippedHeading, 100)).not.toContain(FALLBACK);
  // Too narrow for the expanded heading's rows, the subject is cut and the body keeps it.
  expect(expandedText(clippedHeading, 14)).toContain(FALLBACK);
});

test("a producer's collapsed preview heading reports the subject it drew whole", () => {
  const whole = {};
  const heading = previewHeadingText(() => `Ask user ${SUBJECT}`, whole);
  expect(headingShowedSubject(whole)).toBe(false);
  heading.render(120);
  expect(headingShowedSubject(whole)).toBe(true);
  // Rows a renderer ended in an ellipsis cut the subject, whatever the heading's text held.
  const clipped = {};
  previewHeadingText(() => `Ask user ${clipToWidth(SUBJECT, 20, "…")}`, clipped).render(120);
  expect(headingShowedSubject(clipped)).toBe(false);
});

test("a collapsed result body sees what its own preview heading showed on the first draw", () => {
  applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
  const harness = createToolPresentationHarness(
    withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: (_args, _theme, context) =>
          previewHeadingText(() => `Ask user ${SUBJECT}`, context.state),
        renderResult: (_result, _options, _theme, context) => subjectBody(context.state),
      },
      { compactSummary: () => ({ action: "ask", subject: SUBJECT, outcome: "success" }) },
    ),
  );
  harness.call({ path: "a.ts" });
  harness.result(textResult("done"));
  const text = stripAnsi(Arr.join(harness.render(120), "\n"));
  expect(text).toContain("BODY");
  expect(text).not.toContain(FALLBACK);
});
