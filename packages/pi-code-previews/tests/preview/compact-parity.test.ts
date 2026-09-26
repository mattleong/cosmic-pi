import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactToolCall } from "../../src/preview/compact-tool-call";
import { formatToolCallDuration } from "../../src/preview/format";
import type { CompactChild, CompactSummary } from "../../src/tools/compact-summary";
import { compactChildren, plainTheme as theme, stripAnsi } from "../support/render";

describe("shared semantic row", () => {
  it("uses identical clipping and detail priorities after branch indentation", () => {
    for (const width of [24, 48, 100])
      for (const timingEnabled of [false, true]) {
        for (const counters of [["", "3 matches"], []]) {
          const fields = {
            subject: "src/" + "long/".repeat(15) + "日本語.ts\n\u001b[2J",
            action: "inspect\tfile",
            counters,
            metadata: ["fallback"],
          };
          const standalone = renderCompactToolCall(
            {
              name: "read",
              phase: "settled",
              summary: { ...fields, outcome: "warning" },
              duration: formatToolCallDuration(12_300),
              elapsedMs: 12_300,
              timingEnabled,
            },
            theme,
            width,
          )[0]!;
          const child = compactChildren(
            [{ ...fields, label: "read", status: "warning", durationMs: 12_300 }],
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

  it("shows selected children's own issues and counts hidden failures", () => {
    const entries: CompactChild[] = Array.from({ length: 8 }, (_, index) => ({
      label: `read-${index}`,
      status: "error",
      issues: [
        {
          severity: "error",
          code: "delivery",
          message: `delivery-${index} failed`,
          detail: "Do not replay the request.",
        },
      ],
    }));
    const rows = compactChildren(entries, 100).map(stripAnsi);
    expect(rows.filter((row) => row.includes("delivery-"))).toHaveLength(5);
    const text = rows.join("\n");
    expect(text).not.toContain("Do not replay");
    expect(rows.at(-1)).toContain("3 more");
    expect(rows.at(-1)).toContain("3 failed");
    // Delivery status belongs to the child, whatever its routine detail says.
    const success = compactChildren([{ label: "read", status: "success" }], 100);
    const failure = compactChildren([{ label: "read", status: "error" }], 100);
    expect(stripAnsi(failure.join(""))).not.toBe(stripAnsi(success.join("")));
  });
});
