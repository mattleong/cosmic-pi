import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { selectCompactChildren } from "../../src/preview/compact-children";
import type { CompactIssue } from "../../src/tools/compact-issues";
import type { CompactChild } from "../../src/tools/compact-summary";
import { compactChildren, stripAnsi } from "../support/render";

const failure: CompactIssue = { severity: "error", code: "remote", message: "Element detached" };
const caution: CompactIssue = { severity: "warning", code: "cleanup", message: "Cleanup pending" };
const hint: CompactIssue = {
  severity: "info",
  code: "page",
  message: "More results available",
  detail: "Use offset=143 to continue.",
};
const plain = (rows: readonly string[]) => rows.map(stripAnsi);
const omissionRows = (rows: string[]) => rows.filter((row) => !/retained-\d/u.test(row));

describe("compact child selection", () => {
  it.each(["tree", "flat"] as const)(
    "caps collapsed %s rows at five and lists every retained child on request",
    (layout) => {
      const entries: CompactChild[] = Array.from({ length: 8 }, (_, index) => ({
        label: `retained-${index}`,
        status: "success",
      }));
      const all = plain(compactChildren(entries, 80, { total: 12, all: true, layout }));
      const labels = all.map((row) => row.match(/retained-\d/u)?.[0]).filter(Boolean);
      expect(labels).toEqual(entries.map((entry) => entry.label));
      expect(omissionRows(all)).toEqual([expect.stringContaining("4")]);
      expect(selectCompactChildren({ entries, total: 12 }).entries).toEqual(entries.slice(3));
      const collapsed = plain(compactChildren(entries, 80, { total: 12, layout }));
      expect(collapsed.filter((row) => /retained-\d/u.test(row))).toHaveLength(5);
      expect(omissionRows(collapsed)).toEqual([expect.stringContaining("7")]);
    },
  );

  it("preserves repeated calls and input order without mutating provider data", () => {
    const entries: readonly CompactChild[] = Object.freeze([
      Object.freeze({ label: "read", status: "success" as const }),
      Object.freeze({ label: "read", status: "success" as const }),
      Object.freeze({ label: "grep", status: "running" as const }),
    ]);
    expect(selectCompactChildren({ entries, total: 3 })).toEqual({
      entries,
      omitted: 0,
      hiddenFailed: 0,
    });
  });

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

  it("counts only hidden failures, not hidden warnings, cancellations or successes", () => {
    const entries: CompactChild[] = [
      ...Array.from(
        { length: 4 },
        (_, index): CompactChild => ({
          label: `old-failure-${index}`,
          status: "error",
        }),
      ),
      { label: "old-warning", status: "warning" },
      { label: "old-cancelled", status: "cancelled" },
      ...Array.from(
        { length: 5 },
        (_, index): CompactChild => ({
          label: `recent-failure-${index}`,
          status: "error",
        }),
      ),
      { label: "recent-success", status: "success" },
    ];
    const selected = selectCompactChildren({ entries, total: 20 });
    expect(selected.entries.map((entry) => entry.label)).toEqual(
      Array.from({ length: 5 }, (_, index) => `recent-failure-${index}`),
    );
    expect(selected.hiddenFailed).toBe(4);
    expect(selected.omitted).toBe(15);
    const omission = plain(compactChildren(entries, 100, { total: 20 })).at(-1)!;
    expect(omission).toContain("15");
    expect(omission).toContain("4 failed");
    const quiet = plain(compactChildren(entries.slice(4), 100, { total: 8 })).at(-1)!;
    expect(quiet).not.toContain("failed");
  });

  it("preserves complete omitted and failed counts even when active calls fill the tree", () => {
    for (const hiddenFailed of [1, 12]) {
      const entries: CompactChild[] = [
        ...Array.from(
          { length: hiddenFailed },
          (): CompactChild => ({ label: "old", status: "error" }),
        ),
        ...Array.from({ length: 5 }, (): CompactChild => ({ label: "active", status: "running" })),
      ];
      const total = hiddenFailed === 1 ? 6 : 129;
      const selected = selectCompactChildren({ entries, total });
      expect(selected.entries).toEqual(entries.slice(hiddenFailed));
      expect(selected.hiddenFailed).toBe(hiddenFailed);
      expect(selected.omitted).toBe(total - 5);
      for (const width of [1, 2, 4, 8, 12, 16, 24, 40, 80]) {
        const rows = plain(compactChildren(entries, width, { total }));
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        const evidence = rows.slice(selected.entries.length).join("").replace(/\s/gu, "");
        expect(evidence).toContain(`${selected.hiddenFailed}failed`);
        expect(evidence).toContain(String(selected.omitted));
      }
    }
  });

  it("bounds even all-active batches without manufacturing omitted entries", () => {
    const entries = Array.from(
      { length: 32 },
      (_, index): CompactChild => ({ label: `call-${index}`, status: "running" }),
    );
    const selected = selectCompactChildren({ entries, total: 40 });
    expect(selected.entries.length).toBeLessThan(entries.length);
    expect(selected.entries.every((entry) => entries.includes(entry))).toBe(true);
    expect(selected.omitted + selected.entries.length).toBe(40);
    expect(selectCompactChildren({ entries: [], total: 40 })).toEqual({
      entries: [],
      omitted: 40,
      hiddenFailed: 0,
    });
  });
});

describe("compact child issues", () => {
  it("shows each collapsed row's primary issue in place of its counter", () => {
    const rows = plain(
      compactChildren(
        [
          {
            label: "first",
            status: "error",
            counters: ["3 lines"],
            issues: [hint, caution, failure],
          },
          { label: "second", status: "warning", counters: ["2 lines"], issues: [hint, caution] },
          { label: "third", status: "success", counters: ["1 line"], issues: [hint] },
        ],
        100,
      ),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Element detached");
    expect(rows[0]).toContain("+1");
    expect(rows[0]).not.toMatch(/3 lines|Cleanup pending/u);
    expect(rows[1]).toContain("Cleanup pending");
    expect(rows[1]).not.toMatch(/2 lines|\+\d/u);
    expect(rows[2]).toContain("1 line");
    const text = rows.join("\n");
    expect(text).not.toContain("More results available");
    expect(text).not.toContain("offset=143");
  });

  it("lists every flat-layout issue with its detail beneath the call", () => {
    const rows = plain(
      compactChildren(
        [
          { label: "first", status: "error", issues: [failure, hint] },
          { label: "second", status: "success" },
        ],
        100,
        { layout: "flat" },
      ),
    );
    const at = (text: string) => rows.findIndex((row) => row.includes(text));
    expect(at("first")).toBe(0);
    expect(at("Element detached")).toBeGreaterThan(at("first"));
    expect(at("More results available")).toBeGreaterThan(at("Element detached"));
    expect(at("offset=143")).toBeGreaterThan(at("More results available"));
    expect(at("second")).toBeGreaterThan(at("offset=143"));
    expect(rows.filter((row) => row.includes("Element detached"))).toHaveLength(1);
  });

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
    // With room, the reason stays on the row itself.
    expect(
      plain(compactChildren([{ label: "bash", status: "error", issues: [issue] }], 100)),
    ).toHaveLength(1);
  });

  it("wraps flat-layout issues at narrow widths without clipping text", () => {
    const issue: CompactIssue = {
      severity: "warning",
      code: "retained",
      message: "Output was truncated before completion",
      detail: "Read /tmp/retained-output-1234567890.txt before retrying.",
    };
    for (const width of [2, 4, 6, 8, 12, 20, 40, 80]) {
      const rows = plain(
        compactChildren(
          [
            {
              label: "server.tool",
              subject: "directory/".repeat(40),
              status: "warning",
              issues: [issue],
            },
          ],
          width,
          { layout: "flat" },
        ),
      );
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      const text = rows.slice(1).join("").replace(/\s/gu, "");
      expect(text).toContain(issue.message.replace(/\s/gu, ""));
      expect(text).toContain(issue.detail!.replace(/\s/gu, ""));
    }
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

  it("preserves call identity while eliding long targets like standalone headers", () => {
    const subject = `src/${"long-directory/".repeat(20)}target.ts`;
    for (const width of [40, 60, 80]) {
      const rows = compactChildren([{ label: "read", subject, status: "success" }], width);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(rows.join("")).toContain("read");
      expect(rows.join("")).toContain("src/");
      expect(rows.join("")).toContain("target.ts");
    }
  });

  it.each(["tree", "flat"] as const)(
    "shows measured %s durations only when timing is enabled",
    (layout) => {
      const statuses = ["pending", "running", "success", "error", "cancelled"] as const;
      // Every call, bash included, shows its duration only from one second.
      for (const [label, measured, shown] of [
        ["bash", 1_230, "1.2s"],
        ["bash", 123, undefined],
        ["read", 12_300, "12.3s"],
        ["read", 123, undefined],
      ] as const)
        for (const status of statuses)
          for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, measured])
            for (const timing of [false, true]) {
              const child: CompactChild = {
                label,
                status,
                ...(durationMs !== undefined && { durationMs }),
              };
              const text = compactChildren([child], 80, { timing, layout }).join("");
              expect(text.includes(shown ?? "123ms"), `${label} ${status} ${durationMs}`).toBe(
                shown !== undefined && timing && status !== "pending" && durationMs === measured,
              );
              expect(text).not.toMatch(/NaN|Infinity|-1ms/u);
            }
    },
  );
});
