import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import { fullScreenKeybindingOptions, splitKeyLabel } from "../src/manager/key-labels.ts";
import { SearchableSelectPage } from "../src/manager/searchable-select.ts";

const choice = (name: string) => {
  const value = `openai/model-${name}`;
  return {
    value,
    item: { value, label: value, description: `Model ${name}` },
    searchText: `openai model ${name}`,
    payload: value,
  };
};

const page = (height = 14, notice?: string) => {
  const options = {
    theme: plainTheme,
    breadcrumb: "/profiles › reviewer › Primary › Model",
    title: "Choose model",
    subtitle: "[G] global · Local Pi",
    choices: [choice("one"), choice("two")],
    current: "openai/model-one",
    notice,
    getHeight: () => height,
    requestRender: vi.fn(),
    select: vi.fn(),
    cancel: vi.fn(),
  };
  return { component: new SearchableSelectPage<string>(options), select: options.select, options };
};

describe("searchable selector state", () => {
  it("closes opt-in search on one cancel without selecting a value", () => {
    for (const initialQuery of ["", "two"]) {
      for (const input of ["\u001b", "\u0003"]) {
        const fixture = page();
        const component = new SearchableSelectPage({
          ...fixture.options,
          initialSearchMode: true,
          initialQuery,
          cancelBehavior: "close",
          matchesKeybinding: (data, id) => id === "tui.select.cancel" && data === "\u0003",
        });
        component.handleInput(input);
        expect(fixture.options.cancel).toHaveBeenCalledTimes(1);
        expect(fixture.select).not.toHaveBeenCalled();
      }
    }
  });

  it("keeps printable selection bindings as search text", () => {
    for (const input of ["x", "X", " "]) {
      for (const binding of [
        "tui.select.up",
        "tui.select.down",
        "tui.select.confirm",
        "tui.select.cancel",
      ]) {
        const fixture = page();
        const component = new SearchableSelectPage({
          ...fixture.options,
          initialSearchMode: true,
          cancelBehavior: "close",
          matchesKeybinding: (data, id) => id === binding && data === input,
        });
        component.handleInput(input);
        expect(component.searchState.query).toBe(input);
        expect(fixture.options.cancel).not.toHaveBeenCalled();
        expect(fixture.select).not.toHaveBeenCalled();
      }
    }
  });
});

describe("configured key labels", () => {
  it("reads `/` as a key, not a separator", () => {
    expect(splitKeyLabel("Esc/C-c")).toEqual(["Esc", "C-c"]);
    expect(splitKeyLabel("/")).toEqual(["/"]);
    expect(splitKeyLabel("C-//Esc")).toEqual(["C-/", "Esc"]);
    expect(splitKeyLabel("Esc//")).toEqual(["Esc", "/"]);
  });

  it("names only the primary configured keys until help expands, then every cancel alias", () => {
    const fixture = page();
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.cancel": ["escape", "ctrl+c"],
    });
    const component = new SearchableSelectPage({
      ...fixture.options,
      ...fullScreenKeybindingOptions(keys),
    });
    const screen = () => Arr.join(component.render(120), "\n");
    expect(screen()).toContain("↑↓ Move");
    expect(screen()).toContain("Esc Back");
    expect(screen()).not.toContain("C-c");
    component.handleInput("?");
    expect(screen()).toMatch(/Esc\/C-c\/h\/q Back/u);
  });
});
