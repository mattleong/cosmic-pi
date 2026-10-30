import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { selectCompactChildren } from "../../src/preview/compact-children";
import type { CompactIssue } from "../../src/tools/compact-issues";
import type { CompactChild } from "../../src/tools/compact-summary";
import { compactChildren, stripAnsi } from "../support/render";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Order from "effect/Order";

const plain = (rows: readonly string[]) => Arr.map(rows, stripAnsi);

describe("compact child selection", () => {
  it("keeps active and problem calls ahead of recent completions, with exact hidden totals", () => {
    const entries: CompactChild[] = [
      { label: "failed", status: "error" },
      { label: "active", status: "running" },
      ...Array.from(
        { length: 30 },
        (_, index): CompactChild => ({ label: `done-${index}`, status: "success" }),
      ),
    ];
    for (const total of [40, 270]) {
      const selected = selectCompactChildren({ entries, total });
      expect(selected.entries).toHaveLength(5);
      expect(selected.entries).toContain(entries[0]);
      expect(selected.entries).toContain(entries[1]);
      expect(selected.entries.at(-1)).toBe(entries.at(-1));
      expect(selected.omitted).toBe(total - 5);
      expect(selected.hiddenFailed).toBe(0);
      const order = Arr.map(selected.entries, (entry) => entries.indexOf(entry));
      expect(order).toEqual(Arr.sort(order, Order.Number));
    }
  });
});

const pick = (entries: readonly CompactChild[], limit: number) =>
  selectCompactChildren({ entries, total: entries.length }, limit).entries;

describe("compact child priority", () => {
  it("ranks a call awaiting a reply below problems but above routine completions", () => {
    const asks: CompactIssue = { severity: "attention", code: "question", message: "worker asks" };
    const routine = Array.from(
      { length: 6 },
      (_, index): CompactChild => ({ label: `done-${index}`, status: "success" }),
    );
    const failed: CompactChild = { label: "failed", status: "error" };
    const warned: CompactChild = { label: "warned", status: "warning" };
    const asking: CompactChild = { label: "asking", status: "attention" };
    const askingIssue: CompactChild = { label: "issue", status: "success", issues: [asks] };
    const problems = [asking, ...routine, failed, warned];
    expect(pick(problems, 2)).toEqual([failed, warned]);
    expect(pick(problems, 3)).toEqual([asking, failed, warned]);
    expect(pick([askingIssue, ...routine], 1)).toEqual([askingIssue]);
    expect(pick([asking, ...routine, failed], 1)).toEqual([failed]);
  });
});

describe("compact child issues", () => {
  it("moves a tree row's reason beneath the row rather than dropping it on narrow widths", () => {
    const issue: CompactIssue = {
      severity: "error",
      code: "exit",
      message: "Exited with code 1 after the lint step",
    };
    for (const width of [24, 40, 56, 100]) {
      const rows = plain(
        compactChildren(
          [
            {
              label: "bash",
              subject: "pnpm lint --max-warnings 0",
              status: "error",
              issues: [issue],
            },
            { label: "read", subject: "package.json", status: "success" },
          ],
          width,
        ),
      );
      expect(Arr.every(rows, (row) => visibleWidth(row) <= width)).toBe(true);
      expect(Fn.pipe(Arr.join(rows, ""), Str.replace(/[\s│]/gu, ""))).toContain(
        Fn.pipe(issue.message, Str.replace(/\s/gu, "")),
      );
      expect(Arr.filter(rows, (row) => Fn.pipe(row, Str.includes("read")))).toHaveLength(1);
    }
    expect(
      plain(compactChildren([{ label: "bash", status: "error", issues: [issue] }], 100)),
    ).toHaveLength(1);
  });
});

describe("compact child rows", () => {
  it.each(["tree", "flat"] as const)(
    "renders untrusted %s child names as inert width-bounded text",
    (layout) => {
      for (const width of [1, 4, 16, 40, 100]) {
        const rows = compactChildren(
          [
            {
              label: Fn.pipe("read\n日本語\t\u001b[2J\r", Str.repeat(30)),
              subject: Fn.pipe("path\n日本語\t\u001b[2J\r", Str.repeat(30)),
              status: "returned",
              issues: [{ severity: "error", code: "x", message: "bad\n\u001b[2Jtext" }],
            },
          ],
          width,
          { layout },
        );
        expect(Arr.every(rows, (row) => visibleWidth(row) <= width)).toBe(true);
        expect(Arr.join(rows, "")).not.toContain("\u001b[2J");
        expect(stripAnsi(Arr.join(rows, ""))).not.toMatch(/[\n\r\t]/u);
      }
    },
  );
});
