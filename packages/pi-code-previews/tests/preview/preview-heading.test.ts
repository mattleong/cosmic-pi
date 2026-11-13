import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Fn from "effect/Function";
import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { layoutPreviewHeadingRow, wrappedPreviewHeading } from "../../src/preview/preview-heading";
import { wrapPreviewHeading } from "../../src/preview/heading-wrap";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { plainTheme as theme, stripAnsi } from "../support/render";

const summary = {
  subject: "auth-review",
  counters: ["2 finished · 1 failed · 1 with warnings", "2 finished · 1 failed", "2 finished"],
  metadata: ["84k tokens"],
};
const row = (width: number) =>
  stripAnsi(layoutPreviewHeadingRow("Agent report", summary, false, theme, width).row);

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
  const cut = stripAnsi(layoutPreviewHeadingRow("Agent report", long, false, theme, 50).row);
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
    const cut = stripAnsi(
      layoutPreviewHeadingRow("Background task", notice, false, theme, width).row,
    );
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
  const preview = stripAnsi(
    layoutPreviewHeadingRow("Shared checkout", peers, false, theme, 57).row,
  );
  expect(preview).toMatch(/ db-migration… · also work here$/u);
  const [compact = ""] = renderCompactToolCall(
    { name: "shared_checkout", phase: "settled", summary: { ...peers, outcome: "success" } },
    theme,
    50,
  );
  expect(stripAnsi(compact)).toMatch(/db-migration… · also work here$/u);
});

// Sol's round-7 case: a 449-character command, wider than any heading row, ending in a flag.
const extremeNotice = {
  subject: `node scripts/verify.ts ${Arr.join(
    Arr.map(Arr.range(0, 19), (index) => `--include=package-${index}`),
    " ",
  )} --security-check`,
  metadata: ["finished in 399ms"],
};

test("a collapsed heading keeps its whole outcome beside a subject of any length", () => {
  expect(extremeNotice.subject).toHaveLength(449);
  for (const width of [57, 180]) {
    const heading = stripAnsi(
      layoutPreviewHeadingRow("Background task", extremeNotice, false, theme, width).row,
    );
    expect(heading).toMatch(/… · finished in 399ms$/u);
    expect(heading).not.toContain("[truncated]");
    expect(visibleWidth(heading)).toBeLessThanOrEqual(width);
  }
});

test("an expanded heading wraps a subject of any length whole and keeps its outcome", () => {
  for (const width of [57, 180]) {
    const rows = wrappedPreviewHeading("Background task", extremeNotice, theme, width);
    const words = Arr.join(
      Arr.map(rows, (line) => Str.trim(stripAnsi(line))),
      " ",
    );
    expect(words).toBe(`Background task ${extremeNotice.subject} · finished in 399ms`);
    for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

test("a wrapped heading keeps a direction arrow with the name it points at", () => {
  for (const arrow of ["→", "←"]) {
    const heading = `Message ${arrow} billing-and-invoicing-migration-review-follow-up`;
    const rows = Arr.map(wrapPreviewHeading(heading, 56), stripAnsi);
    expect(rows.length).toBeGreaterThan(1);
    for (const line of rows) expect(Fn.pipe(Str.trimEnd(line), Str.endsWith(arrow))).toBe(false);
    expect(Str.trim(rows[1] ?? "")).toBe(
      `${arrow} billing-and-invoicing-migration-review-follow-up`,
    );
  }
});

test("a name too wide for a row breaks after a hyphen rather than inside a word", () => {
  const name = "billing-and-invoicing-migration-review-follow-up-for-the-legacy-ledger-export-v2";
  for (const width of [57, 40, 24]) {
    const rows = Arr.map(wrapPreviewHeading(`agent_message ${name}`, width), (line) =>
      Str.trim(stripAnsi(line)),
    );
    expect(Arr.join(rows, "")).toBe(`agent_message ${name}`);
    for (const line of rows.slice(0, -1)) expect(Fn.pipe(line, Str.endsWith("-"))).toBe(true);
  }
  // A path whose directory is too wide breaks after its `/` before inside the name.
  const path = Arr.map(wrapPreviewHeading("Status packages/pi-code-previews/src", 16), (line) =>
    Str.trim(stripAnsi(line)),
  );
  expect(path[0]).toBe("Status packages/");
  expect(path[1]).toBe("pi-code-");
});
