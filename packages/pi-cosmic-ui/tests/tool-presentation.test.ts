import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderToolHeader, renderToolSections } from "../src/tool/presentation.ts";

// SAFETY: These pure helpers use only fg and bold.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const TEST_WIDTHS = [20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120];

describe("tool presentation", () => {
  it("sanitizes and bounds tool header subtitles", () => {
    const header = renderToolHeader(
      { title: "tool\nname", subtitle: "x".repeat(200), maxSubtitleWidth: 24 },
      theme,
    );
    expect(header).not.toContain("\n");
    expect(visibleWidth(header)).toBeLessThan(40);
  });

  it.each(TEST_WIDTHS)("bounds semantic sections at width %i", (width) => {
    const rows = renderToolSections(
      [{ heading: "Output", lines: ["x".repeat(200)], tone: "output" }],
      theme,
      width,
    );
    expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  });
});
