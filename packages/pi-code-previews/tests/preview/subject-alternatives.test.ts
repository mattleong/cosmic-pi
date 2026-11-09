import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "vitest";
import { expansionTag } from "../../testing";
import { layoutCompactRow, layoutExpandedCompactHeading } from "../../src/preview/compact-row";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { previewHeadingRow } from "../../src/preview/preview-heading";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { plainTheme as theme, stripAnsi } from "../support/render";

const stopped: CompactSummary = {
  subject: "auth-review, db-migration",
  subjectAlternatives: ["auth-review +1", "2 subagents"],
  counters: ["on reload"],
  outcome: "cancelled",
};

const row = (summary: CompactSummary, width: number) =>
  layoutCompactRow({ name: "subagents_stopped", phase: "settled", summary }, theme, width);

/** The narrowest width whose row shows the whole subject. */
const wholeWidth = (summary: CompactSummary) => {
  let width = 20;
  while (!row(summary, width).subjectComplete) width++;
  return width;
};

test("a compact row shows a narrower whole form of its subject before cutting it", () => {
  const whole = wholeWidth(stopped);
  expect(stripAnsi(row(stopped, whole).row)).toContain("auth-review, db-migration · on reload");
  const narrow = row(stopped, whole - 1);
  expect(stripAnsi(narrow.row)).toContain("auth-review +1 · on reload");
  expect(stripAnsi(narrow.row)).not.toContain("…");
  // The row doesn't show the subject itself, so a body may not leave it out.
  expect(narrow.subjectComplete).toBe(false);
  for (const width of [whole - 1, whole - 6, whole - 12])
    expect(visibleWidth(row(stopped, width).row)).toBeLessThanOrEqual(width);
});

test("a narrower form never costs the fact a cut subject keeps", () => {
  // Too narrow for any form beside the counter: the subject is cut and the counter stays.
  const summary: CompactSummary = { ...stopped, subjectAlternatives: ["auth-review +1"] };
  const width = visibleWidth("⊘ subagents_stopped auth-review… · on reload");
  const { row: drawn } = row(summary, width);
  expect(stripAnsi(drawn)).toMatch(/… · on reload$/u);
  expect(stripAnsi(drawn)).not.toContain("+1");
});

test("a row that keeps no fact shows a narrower form alone before cutting", () => {
  const summary: CompactSummary = {
    subject: "auth-review, db-migration",
    subjectAlternatives: ["auth-review +1"],
    outcome: "cancelled",
  };
  const width = visibleWidth("⊘ subagents_stopped auth-review +1");
  expect(stripAnsi(row(summary, width).row)).toBe("⊘ subagents_stopped auth-review +1");
});

test("an expanded heading wraps the whole subject, not a narrower form", () => {
  const { rows, subjectComplete } = layoutExpandedCompactHeading(
    {
      name: "subagents_stopped",
      phase: "settled",
      summary: stopped,
      expanded: true,
      collapsedWidth: 40,
    },
    theme,
    40,
  );
  expect(subjectComplete).toBe(true);
  const text = stripAnsi(Arr.join(rows, " "));
  expect(text).toContain("db-migration");
  expect(text).not.toContain("+1");
});

test("the tag's label never costs the subject its whole form", () => {
  // At 80 columns the whole subject fits beside a bare tag but not beside this label.
  const label = "every stopped run and its state";
  const [first = ""] = renderCompactToolCall(
    { name: "subagents_stopped", phase: "settled", summary: stopped, expandLabel: label },
    theme,
    80,
  );
  expect(stripAnsi(first)).toContain("auth-review, db-migration · on reload");
  expect(expansionTag(first)).toBe("");
  // Wider, the label fits beside the whole subject.
  const [wide = ""] = renderCompactToolCall(
    { name: "subagents_stopped", phase: "settled", summary: stopped, expandLabel: label },
    theme,
    100,
  );
  expect(stripAnsi(wide)).toContain("auth-review, db-migration · on reload");
  expect(expansionTag(wide)).toBe(label);
});

test("a collapsed message heading shows a narrower whole form before cutting its subject", () => {
  const heading = (width: number) =>
    stripAnsi(previewHeadingRow("Subagents stopped", stopped, false, theme, width));
  expect(heading(80)).toContain("auth-review, db-migration · on reload");
  const narrow = heading(
    visibleWidth("Subagents stopped auth-review, db-migration · on reload") - 1,
  );
  expect(narrow).toContain("auth-review +1 · on reload");
  expect(narrow).not.toContain("…");
  // Expanded, a one-row heading shows the subject itself.
  expect(stripAnsi(previewHeadingRow("Subagents stopped", stopped, true, theme, 40))).not.toContain(
    "+1",
  );
});

const failedStop: CompactSummary = {
  ...stopped,
  counters: ["1/2 finished · 1 failed", "1/2 finished"],
  outcome: "error",
};

test("a message heading keeps a whole subject rather than trading it for a narrower form", () => {
  const width = visibleWidth("Subagents stopped auth-review, db-migration") + 1;
  const heading = stripAnsi(
    previewHeadingRow("Subagents stopped", failedStop, false, theme, width),
  );
  expect(heading).toContain("auth-review, db-migration");
});

test("a narrower form never costs a message heading the counter its cut subject keeps", () => {
  const { subjectAlternatives: _, ...withoutForms } = failedStop;
  for (const width of Arr.range(30, 80)) {
    const cutRow = stripAnsi(
      previewHeadingRow("Subagents stopped", withoutForms, false, theme, width),
    );
    const formRow = stripAnsi(
      previewHeadingRow("Subagents stopped", failedStop, false, theme, width),
    );
    if (Str.includes("1 failed")(cutRow)) expect(formRow).toContain("1 failed");
  }
});
