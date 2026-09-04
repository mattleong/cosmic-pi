import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  fullScreenSettingsHint,
  settingsSurfaceBridge,
  VimSettingsAdapter,
} from "../src/manager/settings-adapter.ts";

const makeChild = () => {
  const forwarded: string[] = [];
  const setValue = vi.fn();
  const applyFilter = vi.fn();
  const child = {
    focused: false,
    searchInput: { focused: false, setValue },
    submenuComponent: null,
    applyFilter,
    handleInput: (data: string) => forwarded.push(data),
    render: () => ["settings", ""],
    invalidate: vi.fn(),
  } satisfies Component & Record<string, unknown>;
  return { child, forwarded, setValue, applyFilter };
};

describe("VimSettingsAdapter", () => {
  it("translates modeless Vim navigation for the child list", () => {
    const { child, forwarded } = makeChild();
    const adapter = new VimSettingsAdapter(child);
    adapter.handleInput("j");
    adapter.handleInput("l");
    adapter.handleInput("h");
    expect(forwarded).toEqual(["\x1b[B", "\r", "\x1b"]);
  });

  it("owns search focus and clears the hidden filter on Esc", () => {
    const { child, forwarded, setValue, applyFilter } = makeChild();
    const adapter = new VimSettingsAdapter(child, { search: true });
    adapter.focused = true;
    adapter.handleInput("/");
    adapter.handleInput("a");
    expect(child.searchInput.focused).toBe(true);
    expect(forwarded).toContain("a");
    adapter.handleInput("\x1b");
    expect(setValue).toHaveBeenCalledWith("");
    expect(applyFilter).toHaveBeenCalledWith("");
    expect(child.searchInput.focused).toBe(false);
  });

  it("bridges focus, input hooks, and guarded rendering", () => {
    const { child, forwarded } = makeChild();
    const adapter = new VimSettingsAdapter(child);
    const afterInput = vi.fn();
    const bridge = settingsSurfaceBridge(adapter, child, { afterInput });
    bridge.focused = true;
    bridge.handleInput?.("j");
    expect(adapter.focused).toBe(true);
    expect(forwarded).toContain("\x1b[B");
    expect(afterInput).toHaveBeenCalledTimes(1);
    expect(bridge.render(20)).toEqual(["settings", ""]);
  });

  it("changes hints by mode without relying on exact chrome", () => {
    expect(fullScreenSettingsHint({ searching: true })).toContain("Type to filter");
    expect(fullScreenSettingsHint({ searching: false, search: true })).toContain("/ filter");
  });
});
