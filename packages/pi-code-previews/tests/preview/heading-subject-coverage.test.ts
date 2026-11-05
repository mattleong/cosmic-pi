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
