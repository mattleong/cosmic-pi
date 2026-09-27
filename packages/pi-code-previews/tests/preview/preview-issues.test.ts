import { createReadToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
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

const tool = (placeUnderHeading = false) => {
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
    { compactSummary: summary },
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

test("a failing host theme still shows what went wrong", () => {
  const hostile: Theme = opaqueFixture({
    ...plainTheme,
    fg: () => {
      throw new Error("theme unavailable");
    },
  });
  const harness = createToolPresentationHarness(tool(), { theme: hostile });
  harness.call({ path: "a.ts" }, { executionStarted: true });
  harness.result(textResult("failed"), { isError: true });
  expect(order(harness.render(80))).toContain("PROBLEM");
});
