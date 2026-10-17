import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { selectCompactChildren } from "../../src/preview/compact-children";
import type { CompactIssue } from "../../src/tools/compact-issues";
import type { CompactChild } from "../../src/tools/compact-summary";
import { compactChildren, stripAnsi } from "../support/render";

const plain = (rows: readonly string[]) => rows.map(stripAnsi);

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
      const order = selected.entries.map((entry) => entries.indexOf(entry));
      expect(order).toEqual(order.toSorted((a, b) => a - b));
    }
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
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(rows.join("").replace(/[\s│]/gu, "")).toContain(issue.message.replace(/\s/gu, ""));
      expect(rows.filter((row) => row.includes("read"))).toHaveLength(1);
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
              label: "read\n日本語\t\u001b[2J\r".repeat(30),
              subject: "path\n日本語\t\u001b[2J\r".repeat(30),
              status: "returned",
              issues: [{ severity: "error", code: "x", message: "bad\n\u001b[2Jtext" }],
            },
          ],
          width,
          { layout },
        );
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        expect(rows.join("")).not.toContain("\u001b[2J");
        expect(stripAnsi(rows.join(""))).not.toMatch(/[\n\r\t]/u);
      }
    },
  );
});
