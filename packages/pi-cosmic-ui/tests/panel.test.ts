import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import { TextPanelComponent, type TextPanelDismissMode } from "../src/manager/panel.ts";

const theme = plainTheme;
const TEST_WIDTHS = [0, 1, 2, 3, 4, 20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120];

describe("TextPanelComponent", () => {
  it.each(TEST_WIDTHS)("bounds every line at width %i", (width) => {
    const panel = new TextPanelComponent({
      title: "Diagnostics",
      lines: ["a long diagnostic row that must be safely clipped"],
      done: vi.fn(),
      theme,
      dismiss: "back-keys",
    });
    expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("supports explicit any-key and back-key dismissal policies", () => {
    const panel = (dismiss: TextPanelDismissMode, done: () => void) =>
      new TextPanelComponent({ title: dismiss, lines: [], done, theme, dismiss });
    const anyDone = vi.fn();
    panel("any-key", anyDone).handleInput("x");
    expect(anyDone).toHaveBeenCalledOnce();

    const backDone = vi.fn();
    const back = panel("back-keys", backDone);
    back.handleInput("x");
    expect(backDone).not.toHaveBeenCalled();
    back.handleInput("q");
    expect(backDone).toHaveBeenCalledOnce();
  });
});
