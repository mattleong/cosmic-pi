import { describe, expect, it, vi } from "vitest";
import { createQuestionnaireDock } from "../src/boundary/host-questionnaire-dock.ts";
import { makeTuiHost, opaqueHostFixture } from "./support/host.ts";

const component = () => ({
  focused: false,
  render: () => ["questionnaire"],
  invalidate: vi.fn(),
  handleInput: vi.fn(),
});

const overlay = () =>
  opaqueHostFixture({
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: () => false,
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: () => true,
    getBounds: () => undefined,
  });

describe("questionnaire dock ownership", () => {
  it("forwards keyboard focus while drawing only in the widget", () => {
    const h = makeTuiHost();
    const dock = createQuestionnaireDock(h.ctx.ui);
    const dialog = component();
    dock.mount(opaqueHostFixture(h.tui), dialog);
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
    const h = makeTuiHost();
    const old = createQuestionnaireDock(h.ctx.ui);
    old.mount(opaqueHostFixture(h.tui), component());
    const current = createQuestionnaireDock(h.ctx.ui);
    const dialog = component();
    current.mount(opaqueHostFixture(h.tui), dialog);
    expect(h.widgets.size).toBe(2);
    old.dispose();
    expect(h.widgets.size).toBe(1);
    old.dispose();
    old.mount(opaqueHostFixture(h.tui), component());
    expect(h.widgets.size).toBe(1);
    expect([...h.widgets.values()][0]!.render(80)).toEqual(dialog.render());
    current.dispose();
  });

  it("removes the widget even when overlay closure fails", () => {
    const h = makeTuiHost();
    const dock = createQuestionnaireDock(h.ctx.ui);
    dock.mount(opaqueHostFixture(h.tui), component());
    const handle = dock.handle(
      opaqueHostFixture({
        hide: () => {
          throw new Error("host failure");
        },
      }),
    );
    expect(() => handle.hide()).toThrow();
    expect(h.widgets.size).toBe(0);
  });
});
