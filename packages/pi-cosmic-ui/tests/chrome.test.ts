import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { renderResponsiveManagerFooter } from "../src/manager/chrome.ts";

const TEST_WIDTHS = [0, 1, 20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120];

describe("manager chrome", () => {
  it.each(TEST_WIDTHS)("keeps responsive footer within width %i", (width) => {
    const line = renderResponsiveManagerFooter(width, [
      ["j/k move", "Enter inspect", "Esc close"],
      ["j/k", "Enter", "Esc"],
    ]);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
