import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { formatToolCallDuration } from "../../src/preview/format";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { compactChildren, plainTheme as theme, stripAnsi } from "../support/render";

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
          const child = compactChildren(
            [{ ...summary, label: "read", status: "warning", durationMs: 123 }],
            width + 5,
            { timing: timingEnabled },
          )[0]!;
          expect(stripAnsi(child).slice(5)).toBe(stripAnsi(standalone));
          expect(visibleWidth(child)).toBeLessThanOrEqual(width + 5);
          expect(child).not.toContain("\u001b[2J");
        }
      }
  });

  it("uses standalone live timing thresholds, settings, and detail priority", () => {
    for (const name of ["bash", "read", "mcp", "background_task"])
      for (const elapsedMs of [900, 9999, 10000, 12500])
        for (const timingEnabled of [false, true])
          for (const detail of [undefined, "counter", "metadata"]) {
            const summary: CompactSummary = {
              subject: "target",
              ...(detail === "counter" && { counters: ["result count"] }),
              ...(detail === "metadata" && { metadata: ["result detail"] }),
            };
            const duration = formatToolCallDuration(elapsedMs);
            const standalone = renderCompactToolCall(
              {
                name,
                phase: "running",
                summary,
                duration,
                elapsedMs,
                timingEnabled,
                animationFrame: 3,
              },
              theme,
              100,
            )[0]!;
            const child = compactChildren(
              [{ ...summary, label: name, status: "running", durationMs: elapsedMs }],
              105,
              { frame: 3, timing: timingEnabled },
            )[0]!;
            expect(stripAnsi(child).slice(5)).toBe(stripAnsi(standalone));
            expect(child.includes(duration)).toBe(
              timingEnabled && detail === undefined && (name === "bash" || elapsedMs >= 10000),
            );
          }
  });

  it("keeps selected child recovery independent of the child row budget", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      label: `read-${index}`,
      status: "error" as const,
      outcome: "success" as const,
      notices: [
        {
          kind: "recovery" as const,
          text: `delivery-${index}: do not replay`,
          description: `delivery-${index} failed`,
        },
      ],
    }));
    const rows = compactChildren(entries, 100);
    expect(rows.filter((row) => row.includes("delivery-"))).toHaveLength(5);
    expect(rows.join("\n")).not.toContain("do not replay");
    expect(rows.join("\n")).toContain("3 more");
    // Delivery failure remains authoritative even when the operation succeeded.
    const success = compactChildren(
      [{ label: "read", status: "success", outcome: "success" }],
      100,
    );
    const failure = compactChildren([{ label: "read", status: "error", outcome: "success" }], 100);
    expect(stripAnsi(failure.join(""))).not.toBe(stripAnsi(success.join("")));
  });
});
