import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { selectCompactChildren, renderCompactChildren } from "../../src/preview/compact-children";
import { renderCompactFailure } from "../../src/preview/compact-tool-call";
import {
  isCompactAttention,
  type CompactChild,
  type CompactNotice,
} from "../../src/tools/compact-summary";
import { stripAnsi, testTheme } from "../support/render";

const theme = testTheme();

describe("compact child selection", () => {
  it.each(["tree", "flat"] as const)(
    "expands every retained child in %s view while collapsed selection stays capped at five",
    (layout) => {
      const entries: CompactChild[] = Array.from({ length: 8 }, (_, index) => ({
        label: `retained-${index}`,
        status: "success",
      }));
      const children = { entries, total: 12 };
      const expanded = renderCompactChildren(children, theme, 80, 0, true, true, layout).map(
        stripAnsi,
      );
      expect(expanded.slice(0, -1).map((row) => row.match(/retained-\d/u)?.[0])).toEqual(
        entries.map((entry) => entry.label),
      );
      expect(expanded.at(-1)).toContain("4 more");
      const collapsed = renderCompactChildren(children, theme, 80);
      expect(collapsed).toEqual(renderCompactChildren(children, theme, 80, 0, true, false));
      expect(selectCompactChildren(children).entries).toEqual(entries.slice(3));
      expect(collapsed).toHaveLength(6);
      expect(stripAnsi(collapsed.at(-1)!)).toContain("7 more");
    },
  );

  it.each(["tree", "flat"] as const)(
    "keeps %s informational hints beneath their child and wraps complete warnings",
    (layout) => {
      const warning = "Sensitive content requires review before sharing with another recipient.";
      const children = {
        entries: [
          {
            label: "first",
            status: "success" as const,
            notices: [
              { kind: "recovery" as const, text: "Continue at offset=143", expandedOnly: true },
              { kind: "warning" as const, text: warning, expandedOnly: true },
            ],
          },
          { label: "second", status: "success" as const },
        ],
        total: 2,
      } satisfies { entries: CompactChild[]; total: number };
      for (const expanded of [false, true]) {
        const rows = renderCompactChildren(children, theme, 35, 0, true, expanded, layout).map(
          stripAnsi,
        );
        expect(rows.every((row) => visibleWidth(row) <= 35)).toBe(true);
        const text = rows.join("\n");
        expect(text.includes("offset=143")).toBe(expanded);
        const warningRows = rows.slice(1, -1).filter((row) => !row.includes("offset=143"));
        expect(warningRows.length).toBeGreaterThan(1);
        expect(warningRows.map((row) => row.replace(/[│╰─]/gu, "").trim()).join(" ")).toBe(warning);
        expect(rows[0]).toContain("first");
        expect(rows.at(-1)).toContain("second");
      }
    },
  );

  it("hides only informational recovery in collapsed children and preserves expanded failure notices", () => {
    const notices: CompactNotice[] = [
      {
        kind: "recovery",
        text: "Continue at offset=143",
        code: "read-pagination",
        expandedOnly: true,
      },
      { kind: "warning", text: "Sensitive content", expandedOnly: true },
      { kind: "error", text: "Independent error", expandedOnly: true },
    ];
    expect(notices.map(isCompactAttention)).toEqual([false, true, true]);
    const children = renderCompactChildren(
      { entries: [{ label: "read", status: "success", notices }], total: 1 },
      theme,
      100,
    ).join("\n");
    expect(children).not.toContain("offset=143");
    expect(children).toContain("Sensitive content");
    expect(children).toContain("Independent error");
    for (const expanded of [false, true]) {
      const text = renderCompactFailure(
        {
          name: "read",
          phase: "settled",
          expanded,
          summary: { subject: "file", outcome: "error", notices },
          failure: { cause: "Failed", details: "Complete failure" },
        },
        theme,
        100,
      ).join("\n");
      expect(text.includes("offset=143")).toBe(expanded);
      expect(text).toContain("Sensitive content");
      expect(text).toContain("Independent error");
    }
  });

  it("preserves repeated calls and input order without mutating provider data", () => {
    const entries: readonly CompactChild[] = Object.freeze([
      Object.freeze({ label: "read", status: "success" as const }),
      Object.freeze({ label: "read", status: "success" as const }),
      Object.freeze({ label: "grep", status: "running" as const }),
    ]);
    expect(selectCompactChildren({ entries, total: 3 })).toEqual({ entries, omitted: 0 });
  });

  it("keeps active and problem calls ahead of recent completions, with exact hidden totals", () => {
    const entries: CompactChild[] = [
      { label: "failed", status: "error" },
      { label: "active", status: "running" },
      ...Array.from(
        { length: 30 },
        (_, index): CompactChild => ({
          label: `done-${index}`,
          status: "success",
        }),
      ),
    ];
    for (const total of [40, 270]) {
      const selected = selectCompactChildren({ entries, total });
      expect(selected.entries.length).toBeLessThan(entries.length);
      expect(selected.entries).toContain(entries[0]);
      expect(selected.entries).toContain(entries[1]);
      expect(selected.entries.at(-1)).toBe(entries.at(-1));
      expect(selected.omitted).toBe(total - selected.entries.length);
      expect(selected.entries.map((entry) => entries.indexOf(entry))).toEqual(
        selected.entries.map((entry) => entries.indexOf(entry)).toSorted((a, b) => a - b),
      );
    }
  });

  it("bounds even all-active batches without manufacturing omitted entries", () => {
    const entries = Array.from(
      { length: 32 },
      (_, index): CompactChild => ({
        label: `call-${index}`,
        status: "running",
      }),
    );
    const selected = selectCompactChildren({ entries, total: 40 });
    expect(selected.entries.length).toBeLessThan(entries.length);
    expect(selected.entries.every((entry) => entries.includes(entry))).toBe(true);
    expect(selected.omitted + selected.entries.length).toBe(40);
    expect(selectCompactChildren({ entries: [], total: 40 })).toEqual({ entries: [], omitted: 40 });
  });

  it.each(["tree", "flat"] as const)(
    "renders untrusted %s child names as inert width-bounded text",
    (layout) => {
      for (const width of [1, 4, 16, 40, 100]) {
        const rows = renderCompactChildren(
          {
            entries: [
              {
                label: "read\n日本語\t\u001b[2J\r".repeat(30),
                subject: "path\n日本語\t\u001b[2J\r".repeat(30),
                status: "returned",
              },
            ],
            total: 1,
          },
          theme,
          width,
          0,
          true,
          true,
          layout,
        );
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        expect(rows.join("")).not.toContain("\u001b[2J");
        expect(stripAnsi(rows.join(""))).not.toMatch(/[\n\r\t]/u);
      }
    },
  );

  it.each(["tree", "flat"] as const)(
    "keeps complete multiline recovery at narrow widths in %s calls",
    (layout) => {
      const recovery =
        "Output was truncated.\nRead /tmp/retained-output-1234567890.txt before deciding whether to retry.";
      for (const width of [1, 2, 4, 6, 7, 8, 12, 20, 40, 80]) {
        for (const expanded of [false, true]) {
          const rows = renderCompactChildren(
            {
              total: 1,
              entries: [
                {
                  label: "server.with.a.long.tool.name",
                  subject: "directory/".repeat(40),
                  status: "warning",
                  notices: [{ kind: "recovery", text: recovery }],
                },
              ],
            },
            theme,
            width,
            0,
            true,
            expanded,
            layout,
          ).map(stripAnsi);
          expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
          expect(
            rows
              .slice(1)
              .join("")
              .replace(/[\s│╰─]/gu, ""),
          ).toBe(recovery.replace(/\s/gu, ""));
        }
      }
    },
  );

  it("preserves call identity while eliding long targets like standalone headers", () => {
    const subject = `src/${"long-directory/".repeat(20)}target.ts`;
    for (const width of [40, 60, 80]) {
      const rows = renderCompactChildren(
        {
          entries: [{ label: "read", subject, status: "success" }],
          total: 1,
        },
        theme,
        width,
      );
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(rows.join("")).toContain("read");
      expect(rows.join("")).toContain("src/");
      expect(rows.join("")).toContain("target.ts");
    }
  });

  it.each(["tree", "flat"] as const)(
    "shows measured %s durations only when timing is enabled",
    (layout) => {
      for (const status of [
        "pending",
        "running",
        "success",
        "error",
        "cancelled",
        "returned",
      ] as const) {
        for (const durationMs of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, 123]) {
          for (const timingEnabled of [false, true]) {
            const rows = renderCompactChildren(
              {
                entries: [
                  {
                    label: "read",
                    status,
                    showTiming: true,
                    ...(durationMs !== undefined && { durationMs }),
                  },
                ],
                total: 1,
              },
              theme,
              80,
              0,
              timingEnabled,
              true,
              layout,
            );
            expect(rows.join("").includes("123ms")).toBe(
              timingEnabled && status !== "pending" && durationMs === 123,
            );
            expect(rows.join("")).not.toMatch(/NaN|Infinity|-1ms/u);
          }
        }
      }
    },
  );

  it("does not let child limits consume owned failure or recovery text", () => {
    const rows = renderCompactFailure(
      {
        name: "code_mode",
        phase: "settled",
        summary: {
          subject: "inspect",
          outcome: "error",
          children: {
            entries: Array.from(
              { length: 32 },
              (): CompactChild => ({
                label: "read",
                status: "success",
              }),
            ),
            total: 270,
          },
          notices: [{ kind: "recovery", text: "Check remote state before retrying." }],
        },
        failure: { cause: "Delivery failed", details: "Delivery failed after dispatch" },
      },
      theme,
      80,
    );
    expect(rows.join("\n")).toContain("Delivery failed");
    expect(rows.join("\n")).toContain("Check remote state before retrying.");
  });
});
