import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  brailleSpinnerFrame,
  managerLayoutTier,
  managerNoticeGlyph,
  managerStateGlyph,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "../src/manager/chrome.ts";

describe("shared manager chrome", () => {
  it("projects stable-width activity frames", () => {
    expect([0, 1, 2, 9].map(brailleSpinnerFrame)).toEqual(["⠋", "⠙", "⠹", "⠏"]);
    expect([0, 1, 2, 3].map(startingSpinnerFrame)).toEqual(["◌", "◔", "◑", "◕"]);
  });

  it("selects the first grouped footer variant that fits", () => {
    const variants = [
      ["↑↓ Select · C-u/d Scroll", "x Stop", "? Help · Esc Close"],
      ["↑↓ · C-u/d", "x Stop", "? · Esc"],
    ];
    const wide = renderResponsiveManagerFooter(80, variants);
    expect(wide).toContain("↑↓ Select · C-u/d Scroll │ x Stop │ ? Help · Esc Close");
    const narrow = renderResponsiveManagerFooter(30, variants);
    expect(narrow).toContain("↑↓ · C-u/d │ x Stop");
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(30);
  });

  it("shares responsive layout tiers across managers", () => {
    expect(managerLayoutTier(0)).toBe("narrow");
    expect(managerLayoutTier(59)).toBe("narrow");
    expect(managerLayoutTier(60)).toBe("stacked");
    expect(managerLayoutTier(99)).toBe("stacked");
    expect(managerLayoutTier(100)).toBe("wide");
  });

  it("keeps a consistent notice glyph vocabulary", () => {
    expect(managerNoticeGlyph("info")).toBe("ℹ");
    expect(managerNoticeGlyph("success")).toBe("✓");
    expect(managerNoticeGlyph("warning")).toBe("⚠");
    expect(managerNoticeGlyph("error")).toBe("✗");
    expect(managerStateGlyph("done")).toBe("✓");
    expect(managerStateGlyph("failed")).toBe("✗");
    expect(managerStateGlyph("stopped")).toBe("⊘");
    expect(managerStateGlyph("stopping")).toBe("◒");
  });
});
