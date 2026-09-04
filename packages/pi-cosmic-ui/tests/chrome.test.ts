import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  brailleSpinnerFrame,
  managerActivityColor,
  managerActivityGlyph,
  managerLayoutTier,
  managerNoticeGlyph,
  managerStateGlyph,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "../src/manager/chrome.ts";

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

  it("provides stable semantic animation and status vocabulary", () => {
    expect(brailleSpinnerFrame(0)).toBe(brailleSpinnerFrame(10));
    expect(startingSpinnerFrame(0)).toBe(startingSpinnerFrame(4));
    expect(managerActivityGlyph("running", 0)).toBe(managerActivityGlyph("running", 10));
    expect(managerActivityColor("failed")).toBe("error");
    expect(managerNoticeGlyph("error")).toBeTruthy();
    expect(managerStateGlyph("stopped")).toBeTruthy();
  });
});
