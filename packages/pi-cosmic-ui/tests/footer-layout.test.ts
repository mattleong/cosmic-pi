import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderModelContextLine } from "../src/footer/layout.ts";
import { renderMetricsLines } from "../src/footer/metrics.ts";
import { renderProviderUsageLines } from "../src/footer/provider-usage.ts";

const plainTheme = { fg: (_color: string, text: string) => text };

describe("footer layout", () => {
  it("pairs provider windows with their reset dates and wraps complete status data", () => {
    const text =
      "Usage: 5h: -- | 7d: 87.5% | 5h ↺ 1h - 9/10 • 2:10p | 7d ↺ 2d - 9/12 • 2:10p | reset-only ↺ 9/13 • 8:00a | arbitrary status";
    const paired = renderProviderUsageLines("OpenAI", text, 80, plainTheme, false);
    expect(paired).toHaveLength(4);
    expect(paired[0]).toContain("OpenAI");
    expect(paired[0]).toContain("5h: --");
    expect(paired[0]).toContain("9/10");
    expect(paired[1]).toContain("9/12");
    expect(paired[2]).toContain("reset-only");
    expect(paired[3]).toContain("arbitrary status");
    expect(paired.join("\n")).toContain("88% left");
    expect(paired.join("\n")).not.toContain("↺");
    expect(paired[1]).not.toContain("OpenAI");

    const lines = renderProviderUsageLines("OpenAI", text, 24, plainTheme, false);
    const rendered = lines.join("\n");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(rendered).toContain("9/10");
    expect(rendered).toContain("9/12");
    expect(lines.every((line) => line.trim() !== "OpenAI")).toBe(true);
  });

  it("keeps every metric contribution as available width changes", () => {
    const contributions = [
      {
        kind: "text" as const,
        id: "session",
        region: "metrics" as const,
        text: "full-session",
        compactText: "sess",
        order: 100,
      },
      {
        kind: "text" as const,
        id: "metrics.input",
        region: "metrics" as const,
        text: "↑100k",
        compactText: "↑1k",
        order: 200,
      },
      {
        kind: "text" as const,
        id: "metrics.output",
        region: "metrics" as const,
        text: "↓12k",
        compactText: "↓2k",
        order: 210,
      },
      {
        kind: "text" as const,
        id: "metrics.cacheRead",
        region: "metrics" as const,
        text: "R40k",
        compactText: "R4k",
        order: 220,
      },
      {
        kind: "text" as const,
        id: "metrics.cacheWrite",
        region: "metrics" as const,
        text: "W10k",
        compactText: "W1k",
        order: 230,
      },
      {
        kind: "text" as const,
        id: "metrics.other",
        region: "metrics" as const,
        text: "full-other",
        compactText: "other",
        order: 235,
      },
      {
        kind: "text" as const,
        id: "metrics.cost",
        region: "metrics" as const,
        text: "$0.123 (sub)",
        compactText: "$0.12",
        align: "right" as const,
        order: 240,
      },
    ];
    const wide = renderMetricsLines(contributions, 80, plainTheme, true);
    expect(wide[0]).toContain("sess");
    expect(wide[0]).toContain("↑1k");
    expect(wide[0]).toContain("↓2k");
    expect(wide[0]).toContain("$0.12");
    expect(wide.join("\n")).toContain("⇄ r4k / w1k");
    expect(wide.join("\n")).toContain("other");

    const narrow = renderMetricsLines(contributions, 24, plainTheme, true);
    const rendered = narrow.join("\n");
    expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
    for (const value of ["sess", "↑1k", "↓2k", "r4k", "w1k", "other", "$0.12"])
      expect(rendered).toContain(value);
    expect(rendered).not.toContain("full-session");
    expect(rendered).not.toContain("full-other");
  });

  it("wraps a long leading metric instead of clipping it against cost", () => {
    const contributions = [
      {
        kind: "text" as const,
        id: "session",
        region: "metrics" as const,
        text: "a-session-name-longer-than-the-entire-row",
      },
      {
        kind: "text" as const,
        id: "metrics.input",
        region: "metrics" as const,
        text: "↑123456",
      },
      {
        kind: "text" as const,
        id: "metrics.cost",
        region: "metrics" as const,
        text: "$0.123 (sub)",
        align: "right" as const,
      },
    ];
    for (const width of [16, 24, 32, 80]) {
      const lines = renderMetricsLines(contributions, width, plainTheme, false);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const content = lines.join("").replace(/\s/gu, "");
      for (const entry of contributions) expect(content).toContain(entry.text.replace(/\s/gu, ""));
    }
  });

  it("right-aligns context when the model identity is hidden", () => {
    const line = renderModelContextLine(
      [],
      { contextWindow: 200_000, tokens: 76_000, percent: 38 },
      40,
      plainTheme,
      false,
    );
    expect(visibleWidth(line)).toBe(40);
    expect(line.indexOf("Ctx")).toBeGreaterThan(0);
    expect(line.trimStart()).toContain("Ctx");
  });
});
