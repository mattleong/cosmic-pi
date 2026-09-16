import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactChildren } from "../../src/preview/compact-children";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { formatToolCallDuration } from "../../src/preview/format";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { stripAnsi, testTheme } from "../support/render";

const theme = testTheme();
describe("shared semantic row", () => {
  it("uses identical clipping and detail priorities after branch indentation", () => {
    for (const width of [24, 48, 100])
      for (const timingEnabled of [false, true]) {
        for (const showTiming of [false, true]) {
          const summary: CompactSummary = {
            subject: "src/" + "long/".repeat(15) + "日本語.ts\n\u001b[2J",
            action: "inspect\tfile",
            counters: ["", "3 matches"],
            metadata: ["fallback"],
            outcome: "warning",
          };
          if (showTiming) summary.showTiming = true;
          const standalone = renderCompactToolCall(
            {
              name: "read",
              phase: "settled",
              summary,
              duration: formatToolCallDuration(123),
              elapsedMs: 123,
              timingEnabled,
            },
            theme,
            width,
          )[0]!;
          const child = renderCompactChildren(
            {
              entries: [{ ...summary, label: "read", status: "warning", durationMs: 123 }],
              total: 1,
            },
            theme,
            width + 5,
            0,
            timingEnabled,
          )[0]!;
          expect(stripAnsi(child).slice(5)).toBe(stripAnsi(standalone));
          expect(visibleWidth(child)).toBeLessThanOrEqual(width + 5);
          expect(child).not.toContain("\u001b[2J");
        }
      }
  });

  it("preserves every recovery character when subtree indentation must yield", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    for (const width of [1, 2, 5, 6, 7, 12, 40]) {
      const rows = renderCompactChildren(
        {
          entries: [{ label: "read", status: "error", notices: [{ kind: "recovery", text }] }],
          total: 1,
        },
        theme,
        width,
      );
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      expect(stripAnsi(rows.slice(1).join("")).replace(/[\s╰─│]/gu, "")).toBe(text);
    }
  });

  it("keeps selected child recovery independent of the child row budget", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      label: `read-${index}`,
      status: "error" as const,
      outcome: "success" as const,
      notices: [{ kind: "recovery" as const, text: `delivery-${index}: do not replay` }],
    }));
    const rows = renderCompactChildren({ entries, total: 8 }, theme, 100);
    expect(rows.filter((row) => row.includes("do not replay"))).toHaveLength(5);
    expect(rows.join("\n")).toContain("3 more");
    // Delivery failure remains authoritative even when the operation succeeded.
    const success = renderCompactChildren(
      { entries: [{ label: "read", status: "success", outcome: "success" }], total: 1 },
      theme,
      100,
    );
    const failure = renderCompactChildren(
      { entries: [{ label: "read", status: "error", outcome: "success" }], total: 1 },
      theme,
      100,
    );
    expect(stripAnsi(failure.join(""))).not.toBe(stripAnsi(success.join("")));
  });
});
