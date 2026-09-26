import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderModelContextLine } from "../src/footer/layout.ts";
import { renderMetricsLines } from "../src/footer/metrics.ts";
import { renderProviderUsageLines } from "../src/footer/provider-usage.ts";
import type { CosmicFooterTextContribution } from "../src/protocol/protocol.ts";

const plainTheme = { fg: (_color: string, text: string) => text };
const metric = (
  id: string,
  text: string,
  extra: Partial<CosmicFooterTextContribution> = {},
): CosmicFooterTextContribution => ({ kind: "text", id, region: "metrics", text, ...extra });

describe("footer layout", () => {
  it("pairs provider windows with their reset dates and wraps complete status data", () => {
    const text =
      "Usage: 5h: -- | 7d: 87.5% | 5h ↺ 1h - 9/10 • 2:10p | 7d ↺ 2d - 9/12 • 2:10p | reset-only ↺ 9/13 • 8:00a | arbitrary status";
    const paired = renderProviderUsageLines("OpenAI", text, 80, plainTheme, false);
    expect(paired.find((line) => line.includes("5h"))).toContain("9/10");
    expect(paired.find((line) => line.includes("7d"))).toContain("9/12");
    for (const value of ["OpenAI", "5h: --", "reset-only", "arbitrary status"])
      expect(paired.join("\n")).toContain(value);
    expect(paired.join("\n")).not.toContain("↺");

    const lines = renderProviderUsageLines("OpenAI", text, 24, plainTheme, false);
    const rendered = lines.join("\n");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(rendered).toContain("9/10");
    expect(rendered).toContain("9/12");
    expect(lines.every((line) => line.trim() !== "OpenAI")).toBe(true);
  });

  it("keeps every compact metric contribution as available width changes", () => {
    const contributions = [
      metric("session", "full-session", { compactText: "sess", order: 100 }),
      metric("metrics.input", "↑100k", { compactText: "↑1k", order: 200 }),
      metric("metrics.output", "↓12k", { compactText: "↓2k", order: 210 }),
      metric("metrics.cacheRead", "R40k", { compactText: "R4k", order: 220 }),
      metric("metrics.cacheWrite", "W10k", { compactText: "W1k", order: 230 }),
      metric("metrics.other", "full-other", { compactText: "other", order: 235 }),
      metric("metrics.cost", "$0.123 (sub)", { compactText: "$0.12", align: "right", order: 240 }),
    ];
    for (const width of [80, 24]) {
      const lines = renderMetricsLines(contributions, width, plainTheme, true);
      const rendered = lines.join("\n");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      for (const value of ["sess", "↑1k", "↓2k", "r4k", "w1k", "other", "$0.12"])
        expect(rendered).toContain(value);
      expect(rendered).not.toContain("full-session");
      expect(rendered).not.toContain("full-other");
    }
  });

  it("wraps a long leading metric instead of clipping it against cost", () => {
    const contributions = [
      metric("session", "a-session-name-longer-than-the-entire-row"),
      metric("metrics.input", "↑123456"),
      metric("metrics.cost", "$0.123 (sub)", { align: "right" }),
    ];
    for (const width of [16, 24, 32, 80]) {
      const lines = renderMetricsLines(contributions, width, plainTheme, false);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const content = lines.join("").replace(/\s/gu, "");
      for (const entry of contributions) expect(content).toContain(entry.text.replace(/\s/gu, ""));
    }
  });

  it("renders context within width when the model identity is hidden", () => {
    const context = { contextWindow: 200_000, tokens: 76_000, percent: 38 };
    const line = renderModelContextLine([], context, 40, plainTheme, false);
    expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    expect(line).toContain("38%");
  });
});
