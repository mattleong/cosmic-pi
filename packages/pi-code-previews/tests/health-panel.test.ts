import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { HealthPanel } from "../src/commands/health.ts";

const TEST_WIDTHS = [0, 1, 2, 3, 4, 20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120];

describe("HealthPanel", () => {
  it.each(TEST_WIDTHS)("never renders beyond width %i", (width) => {
    const panel = new HealthPanel("Code preview health\nlonger detail", vi.fn(), (value) => value);
    expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
