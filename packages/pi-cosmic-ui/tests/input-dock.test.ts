import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { createInputDock, inputDockVisible } from "../src/boundary/host-input-dock.ts";
import { fakeCustomSurfaceHost } from "../src/testing/custom-surface.ts";

const harness = () => {
  const host = fakeCustomSurfaceHost();
  const tui: TUI = opaqueFixture(host.tui);
  return { tui, ui: host.ctx.ui, widgets: host.widgets, overlay: () => host.showUnrelated() };
};
const component = () => ({
  focused: false,
  render: () => ["panel"],
  invalidate: vi.fn(),
  handleInput: vi.fn(),
});

describe("input dock ownership", () => {
  it("forwards keyboard focus while drawing only in the widget", () => {
    const h = harness();
    const dock = createInputDock(h.ui);
    const dialog = component();
    dock.mount(h.tui, dialog);
    const widget = [...h.widgets.values()][0]!;
    dock.input.focused = true;
    expect(dialog.focused).toBe(true);
    dock.input.handleInput?.("x");
    expect(dialog.handleInput).toHaveBeenCalledWith("x");
    expect(dock.input.render(80)).toEqual([]);
    expect(widget.render(80)).toEqual(dialog.render());
    const handle = dock.handle(h.overlay());
    handle.setHidden(true);
    expect(widget.render(80)).toEqual([]);
    dialog.handleInput.mockClear();
    dock.input.handleInput?.("x");
    expect(dialog.handleInput).not.toHaveBeenCalled();
    handle.setHidden(false);
    expect(widget.render(80)).toEqual(dialog.render());
    handle.hide();
    expect(h.widgets.size).toBe(0);
    expect(dialog.focused).toBe(false);
    dock.input.handleInput?.("x");
    expect(dialog.handleInput).not.toHaveBeenCalled();
  });

  it("old disposal and late mounting cannot erase a successor widget", () => {
    const h = harness();
    const old = createInputDock(h.ui);
    old.mount(h.tui, component());
    const current = createInputDock(h.ui);
    const dialog = component();
    current.mount(h.tui, dialog);
    expect(h.widgets.size).toBe(2);
    old.dispose();
    expect(h.widgets.size).toBe(1);
    old.dispose();
    old.mount(h.tui, component());
    expect(h.widgets.size).toBe(1);
    expect([...h.widgets.values()][0]!.render(80)).toEqual(dialog.render());
    current.dispose();
  });

  it("removes the widget even when overlay closure fails", () => {
    const h = harness();
    const dock = createInputDock(h.ui);
    dock.mount(h.tui, component());
    const handle = dock.handle({
      ...h.overlay(),
      hide: () => {
        throw new Error("host failure");
      },
    });
    expect(() => handle.hide()).toThrow();
    expect(h.widgets.size).toBe(0);
  });
});

describe("input dock presence", () => {
  it("is visible only while a mounted dock is shown", () => {
    const h = harness();
    const dock = createInputDock(h.ui);
    expect(inputDockVisible()).toBe(false);
    dock.mount(h.tui, component());
    expect(inputDockVisible()).toBe(true);
    const handle = dock.handle(h.overlay());
    handle.setHidden(true);
    expect(inputDockVisible()).toBe(false);
    handle.setHidden(false);
    expect(inputDockVisible()).toBe(true);
    handle.hide();
    expect(inputDockVisible()).toBe(false);
  });
});
