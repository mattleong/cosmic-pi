import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { createInputDock } from "../src/boundary/host-input-dock.ts";

const harness = () => {
  const widgets = new Map<string, Component>();
  const tui: TUI = opaqueFixture({ terminal: { columns: 200, rows: 60 }, requestRender: vi.fn() });
  const ui: ExtensionUIContext = opaqueFixture({
    setWidget: (key: string, factory: (() => Component) | undefined) => {
      if (factory) widgets.set(key, factory());
      else widgets.delete(key);
    },
  });
  return { tui, ui, widgets };
};
const component = () => ({
  focused: false,
  render: () => ["panel"],
  invalidate: vi.fn(),
  handleInput: vi.fn(),
});
const overlay = (): OverlayHandle => ({
  hide: vi.fn(),
  setHidden: vi.fn(),
  isHidden: () => false,
  focus: vi.fn(),
  unfocus: vi.fn(),
  isFocused: () => true,
  getBounds: () => undefined,
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
    const handle = dock.handle(overlay());
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
      ...overlay(),
      hide: () => {
        throw new Error("host failure");
      },
    });
    expect(() => handle.hide()).toThrow();
    expect(h.widgets.size).toBe(0);
  });
});
