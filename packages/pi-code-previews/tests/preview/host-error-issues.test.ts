import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { afterEach, expect, test } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { planCompactPresentation } from "../../src/tools/compact-presentation";
import {
  compactStatus,
  type CompactSummary,
  type CompactSummaryProvider,
} from "../../src/tools/compact-summary";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { textResult } from "../support/render";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

const HOST_TEXT = "[raw_code] HOST-FAILURE-LINE may already have applied. RECOVERY-STEP";
const unconfirmed = {
  severity: "warning",
  code: "unconfirmed",
  message: "OWN-WARNING",
} as const;

const tool = (compactSummary: CompactSummaryProvider) =>
  withCodePreviewShell(
    { ...createReadToolDefinition("/project"), renderResult: () => new Text("", 0, 0) },
    { compactSummary },
  );

const occurrences = (lines: readonly string[], marker: string) =>
  Arr.filter(lines, (line) => Fn.pipe(line, Str.includes(marker))).length;

const settledFailure = (summary: CompactSummary, expanded: boolean) => {
  const harness = createToolPresentationHarness(tool(() => summary));
  harness.call({ path: "a.ts" }, { executionStarted: true, expanded });
  harness.result(textResult(HOST_TEXT), { isError: true, expanded });
  return harness.render(200);
};

const status = (summary: CompactSummary) =>
  compactStatus(
    "settled",
    planCompactPresentation({ summary, phase: "settled", isError: true, errorText: HOST_TEXT })
      .collapsedSummary,
  );

for (const style of ["compact", "preview"] as const)
  test(`${style}: a summary that explains the failure gets no second host issue`, () => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
    const summary: CompactSummary = { subject: "a.ts", outcome: "error", issues: [unconfirmed] };
    const collapsed = settledFailure(summary, false);
    expect(occurrences(collapsed, "OWN-WARNING")).toBe(1);
    expect(occurrences(collapsed, "HOST-FAILURE-LINE")).toBe(0);
    // The host's raw text stays available once when expanded.
    const expanded = settledFailure(summary, true);
    expect(occurrences(expanded, "OWN-WARNING")).toBe(1);
    expect(occurrences(expanded, "RECOVERY-STEP")).toBe(1);
    expect(status(summary)).toBe("error");
  });

test("an issue detail that already carries the host text is not repeated", () => {
  restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
  const summary: CompactSummary = {
    subject: "a.ts",
    outcome: "error",
    issues: [{ ...unconfirmed, detail: HOST_TEXT }],
  };
  expect(occurrences(settledFailure(summary, true), "RECOVERY-STEP")).toBe(1);
});

test("a host error the summary doesn't explain stays visible", () => {
  restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
  const info = { severity: "info", code: "note", message: "NOTE" } as const;
  for (const summary of [
    { subject: "a.ts", outcome: "success", issues: [info] },
    { subject: "a.ts", outcome: "error" },
  ] satisfies CompactSummary[]) {
    expect(occurrences(settledFailure(summary, false), "HOST-FAILURE-LINE")).toBe(1);
    expect(status(summary)).toBe("error");
  }
});

test("an uncertain outcome stays uncertain under a host error", () => {
  restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact" });
  const summary: CompactSummary = { subject: "a.ts", outcome: "uncertain", issues: [unconfirmed] };
  expect(status(summary)).toBe("uncertain");
  const collapsed = settledFailure(summary, false);
  expect(occurrences(collapsed, "OWN-WARNING")).toBe(1);
  expect(occurrences(collapsed, "HOST-FAILURE-LINE")).toBe(0);
});
