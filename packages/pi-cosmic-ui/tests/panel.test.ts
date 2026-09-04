import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { listDetailFrame } from "../src/manager/list-detail-shell.ts";
import { TextPanelComponent } from "../src/manager/panel.ts";

const frame = listDetailFrame({ fg: (_color, text) => text });
const TEST_WIDTHS = [0, 1, 2, 3, 4, 20, 30, 40, 59, 60, 71, 72, 92, 99, 100, 120];

describe("TextPanelComponent", () => {
  it.each(TEST_WIDTHS)("bounds every line at width %i", (width) => {
    const panel = new TextPanelComponent({
      title: "Diagnostics",
      lines: ["a long diagnostic row that must be safely clipped"],
      done: vi.fn(),
      frame,
      dismiss: "back-keys",
    });
    expect(panel.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("supports explicit any-key and back-key dismissal policies", () => {
    const anyDone = vi.fn();
    const any = new TextPanelComponent({
      title: "Any",
      lines: [],
      done: anyDone,
      frame,
      dismiss: "any-key",
    });
    any.handleInput("x");
    expect(anyDone).toHaveBeenCalledOnce();

    const backDone = vi.fn();
    const back = new TextPanelComponent({
      title: "Back",
      lines: [],
      done: backDone,
      frame,
      dismiss: "back-keys",
    });
    back.handleInput("x");
    expect(backDone).not.toHaveBeenCalled();
    back.handleInput("q");
    expect(backDone).toHaveBeenCalledOnce();
  });
});
