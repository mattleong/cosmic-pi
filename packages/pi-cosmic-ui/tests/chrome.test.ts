import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { managerLayoutTier, renderResponsiveManagerFooter } from "../src/manager/chrome.ts";

const TEST_WIDTHS = [0, 1, 20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120];

describe("manager chrome", () => {
  it("uses the documented responsive boundaries", () => {
    expect(managerLayoutTier(59)).toBe("narrow");
    expect(managerLayoutTier(60)).toBe("stacked");
    expect(managerLayoutTier(99)).toBe("stacked");
    expect(managerLayoutTier(100)).toBe("wide");
  });

  it.each(TEST_WIDTHS)("keeps responsive footer within width %i", (width) => {
    const line = renderResponsiveManagerFooter(width, [
      ["j/k move", "Enter inspect", "Esc close"],
      ["j/k", "Enter", "Esc"],
    ]);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
