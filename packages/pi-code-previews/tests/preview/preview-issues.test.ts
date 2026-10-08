import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { failingTheme } from "pi-cosmic-core/testing";
import { beforeEach, expect, test } from "vitest";
import { previewIssuesSlot } from "../../index";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import type { CompactSummaryProvider } from "../../src/tools/compact-summary";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { textResult } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false }),
);

const failure = {
  severity: "error",
  code: "failed",
  message: "PROBLEM",
  detail: "DETAIL",
} as const;
const risk = { severity: "warning", code: "risk", message: "RISKY" } as const;
const summary: CompactSummaryProvider = ({ phase }) =>
  phase === "settled"
    ? { subject: "subject", outcome: "error", issues: [failure] }
    : { subject: "subject", issues: [risk] };

const tool = (placeUnderHeading = false, compactSummary = summary) => {
  const read = createReadToolDefinition("/project");
  return withCodePreviewShell(
    {
      ...read,
      renderCall: (_args, _theme, context) => {
        const call = new Container();
        call.addChild(new Text("HEADING", 0, 0));
        if (placeUnderHeading) call.addChild(previewIssuesSlot(context));
        call.addChild(new Text("CALL-CONTENT", 0, 0));
        return call;
      },
      renderResult: () => new Text("BODY", 0, 0),
    },
    { compactSummary },
  );
};

/** Which of the markers each rendered line carries, in order; icons and styling are ignored. */
const order = (rendered: readonly string[]) =>
  rendered.flatMap((line) =>
    ["HEADING", "CALL-CONTENT", "PROBLEM", "DETAIL", "RISKY", "BODY"].filter((marker) =>
      line.includes(marker),
    ),
  );

test("preview style shows the summary's issues once, between the call and the result", () => {
  const harness = createToolPresentationHarness(tool());
  harness.call({ path: "a.ts" }, { executionStarted: true });
  harness.result(textResult("failed"), { isError: true });
  expect(order(harness.render(80))).toEqual(["HEADING", "CALL-CONTENT", "PROBLEM", "BODY"]);
  harness.call({ path: "a.ts" }, { expanded: true });
  harness.result(textResult("failed"), { expanded: true, isError: true });
  expect(order(harness.render(80))).toEqual([
    "HEADING",
    "CALL-CONTENT",
    "PROBLEM",
    "DETAIL",
    "BODY",
  ]);
});

test("a tool can place the issues directly under its heading", () => {
  const harness = createToolPresentationHarness(tool(true));
  harness.call({ path: "a.ts" }, { executionStarted: true });
  harness.result(textResult("failed"), { isError: true });
  expect(order(harness.render(80))).toEqual(["HEADING", "PROBLEM", "CALL-CONTENT", "BODY"]);
});

test("argument warnings show before any result exists", () => {
  const harness = createToolPresentationHarness(tool(true));
  harness.call({ path: "a.ts" });
  expect(order(harness.render(80))).toEqual(["HEADING", "RISKY", "CALL-CONTENT"]);
});

const hostile = failingTheme();

test("a failing host theme still shows every issue line within the row width", () => {
  const message = "The remote service rejected the request after retries";
  const narrow: CompactSummaryProvider = () => ({
    subject: "subject",
    outcome: "error",
    issues: [
      {
        severity: "error",
        code: "failed",
        message,
        detail: "first detail line\nsecond \u001b[31mdetail line",
      },
    ],
  });
  const harness = createToolPresentationHarness(tool(false, narrow), { theme: hostile });
  harness.call({ path: "a.ts" }, { executionStarted: true, expanded: true });
  harness.result(textResult("failed"), { isError: true, expanded: true });
  for (const width of [20, 7]) {
    for (const line of harness.render(width)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line.includes("\n") || line.includes("\u001b")).toBe(false);
    }
  }
  const text = harness.render(20).join(" ").replace(/\s+/gu, " ");
  for (const fact of [message, "first detail line", "detail line"]) expect(text).toContain(fact);
  harness.call({ path: "a.ts" }, { executionStarted: true });
  harness.result(textResult("failed"), { isError: true });
  expect(harness.render(80).join(" ")).toContain(message);
});

test("animation ticks reuse the issues while the result's evidence is unchanged", () => {
  let provided = 0;
  const harness = createToolPresentationHarness(
    tool(false, (input) => {
      provided += 1;
      return summary(input);
    }),
  );
  harness.call({ path: "a.ts" }, { executionStarted: true });
  harness.result(textResult("failed"), { isError: true });
  harness.render(80);
  const before = provided;
  // Like Pi, each invalidation rebuilds both slots around a fresh result envelope.
  harness.invalidate();
  harness.invalidate();
  expect(order(harness.render(80))).toEqual(["HEADING", "CALL-CONTENT", "PROBLEM", "BODY"]);
  expect(provided).toBe(before);
});
