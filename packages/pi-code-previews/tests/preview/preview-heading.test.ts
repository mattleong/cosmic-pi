import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { previewHeadingRow } from "../../src/preview/preview-heading";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { plainTheme as theme, stripAnsi } from "../support/render";

const summary = {
  subject: "auth-review",
  counters: ["2 finished · 1 failed · 1 with warnings", "2 finished · 1 failed", "2 finished"],
  metadata: ["84k tokens"],
};
const row = (width: number) =>
  stripAnsi(previewHeadingRow("Agent report", summary, false, theme, width));

test("a one-row preview heading shows the widest counter alternative that fits whole", () => {
  expect(row(100)).toContain("2 finished · 1 failed · 1 with warnings · 84k tokens");
  expect(row(50)).toContain("auth-review · 2 finished · 1 failed");
  expect(row(50)).not.toContain("warnings");
  expect(row(40)).toContain("auth-review · 2 finished");
  for (const width of [20, 40, 50, 100])
    expect(visibleWidth(row(width))).toBeLessThanOrEqual(width);
});

test("a cut subject keeps the first counter alternative that leaves it room", () => {
  const long = { ...summary, subject: "a review of every authentication path in the service" };
  const cut = stripAnsi(previewHeadingRow("Agent report", long, false, theme, 50));
  expect(cut).toContain("…");
  expect(cut).toMatch(/2 finished/u);
  expect(visibleWidth(cut)).toBeLessThanOrEqual(50);
});

test("a cut subject without counters keeps its first metadata, so the row keeps its outcome", () => {
  const notice = {
    subject: "pnpm vitest run --reporter=dot tests/task-service.test.ts tests/log-buffer.test.ts",
    metadata: ["finished in 1m 33s", "task-0000000017"],
  };
  for (const width of [57, 100]) {
    const cut = stripAnsi(previewHeadingRow("Background task", notice, false, theme, width));
    expect(cut).toMatch(/…/u);
    expect(cut).toContain(" · finished in 1m 33s");
    expect(cut).not.toContain("task-0000000017");
    // The subject is cut between words, never inside one.
    expect(notice.subject).toContain(`${/^Background task (.*)…/u.exec(cut)?.[1] ?? "-"} `);
    expect(visibleWidth(cut)).toBeLessThanOrEqual(width);
  }
});

test("a subject cut beside a counter ends at a word boundary, in both heading styles", () => {
  const peers = { subject: "db-migration, schema-check", counters: ["also work here"] };
  const preview = stripAnsi(previewHeadingRow("Shared checkout", peers, false, theme, 57));
  expect(preview).toMatch(/ db-migration… · also work here$/u);
  const [compact = ""] = renderCompactToolCall(
    { name: "shared_checkout", phase: "settled", summary: { ...peers, outcome: "success" } },
    theme,
    50,
  );
  expect(stripAnsi(compact)).toMatch(/db-migration… · also work here$/u);
});
