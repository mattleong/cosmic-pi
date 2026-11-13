import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import {
  configuredKeyLabels,
  fullScreenKeybindingOptions,
  splitKeyLabel,
} from "../src/manager/key-labels.ts";
import {
  SearchableSelectPage,
  type SearchableSelectPageOptions,
} from "../src/manager/searchable-select.ts";

const choice = (name: string) => {
  const value = `openai/model-${name}`;
  return {
    value,
    item: { value, label: value, description: `Model ${name}` },
    searchText: `openai model ${name}`,
    payload: value,
  };
};

const page = (overrides: Partial<SearchableSelectPageOptions<string>> = {}) => {
  const select = vi.fn();
  const cancel = vi.fn();
  const component = new SearchableSelectPage<string>({
    theme: plainTheme,
    breadcrumb: "/profiles › reviewer › Primary › Model",
    title: "Choose model",
    subtitle: "[G] global · Local Pi",
    choices: [choice("one"), choice("two")],
    current: "openai/model-one",
    getHeight: () => 14,
    requestRender: vi.fn(),
    select,
    cancel,
    ...overrides,
  });
  return { component, select, cancel };
};

describe("searchable selector state", () => {
  it("closes opt-in search on one cancel without selecting a value", () => {
    for (const initialQuery of ["", "two"]) {
      for (const input of ["\u001b", "\u0003"]) {
        const { component, select, cancel } = page({
          initialSearchMode: true,
          initialQuery,
          cancelBehavior: "close",
          matchesKeybinding: (data, id) => id === "tui.select.cancel" && data === "\u0003",
        });
        component.handleInput(input);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(select).not.toHaveBeenCalled();
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
        const { component, select, cancel } = page({
          initialSearchMode: true,
          cancelBehavior: "close",
          matchesKeybinding: (data, id) => id === binding && data === input,
        });
        component.handleInput(input);
        expect(component.searchState.query).toBe(input);
        expect(cancel).not.toHaveBeenCalled();
        expect(select).not.toHaveBeenCalled();
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

  it("splits Pi's configured cancel keys into a primary key and its aliases", () => {
    const keys = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.cancel": ["escape", "ctrl+c"],
    });
    expect(
      configuredKeyLabels(fullScreenKeybindingOptions(keys).keybindingLabel, new Set()).binding(
        "tui.select.cancel",
        "Esc",
      ),
    ).toEqual({ key: "Esc", aliases: ["C-c"] });
  });
});

const grouped = (value: string, group?: string) => ({
  value,
  item: { value, label: value },
  searchText: value,
  payload: value,
  group,
});

const groupedPage = (height = 20) => {
  const { component, select } = page({
    getHeight: () => height,
    choices: [
      grouped("beta/one", "beta"),
      grouped("alpha/one", "alpha"),
      grouped("beta/two", "beta"),
      grouped("inherit"),
      grouped("alpha/two", "alpha"),
    ],
    current: undefined,
  });
  const screen = () => Arr.join(component.render(60), "\n");
  return { component, select, screen };
};

describe("grouped choices", () => {
  it("moves between choices without stopping on headings", () => {
    const { component, select } = groupedPage();
    for (const expected of ["inherit", "beta/one", "beta/two", "alpha/one", "alpha/two"]) {
      component.handleInput("\r");
      expect(select).toHaveBeenLastCalledWith(expected);
      component.handleInput("j");
    }
  });

  it("counts only choices and keeps a heading only while its group has matches", () => {
    const { component, screen } = groupedPage(9);
    expect(screen()).toMatch(/\b1 of 5\b/u);
    component.handleInput("/");
    for (const key of "alpha") component.handleInput(key);
    const filtered = screen();
    expect(filtered).toContain("alpha/one");
    expect(filtered).not.toContain("beta");
    expect(filtered).not.toContain("inherit");
  });
});

describe("embedded select", () => {
  it("draws its rows for a host pane and takes the same input", () => {
    const { component, select } = groupedPage();
    const rows = component.renderBody(30, 8);
    expect(rows.length).toBeLessThanOrEqual(8);
    for (const row of rows) {
      expect(row).not.toMatch(/[│╭╰]/u);
      expect(visibleWidth(row)).toBeLessThanOrEqual(30);
    }
    expect(Arr.join(rows, "\n")).toContain("inherit");
    const hints = component.keyHints(40);
    expect(visibleWidth(hints.border)).toBeLessThanOrEqual(40);
    expect(`${hints.border} ${hints.overflow}`).toContain("Move");
    component.handleInput("j");
    component.handleInput("\r");
    expect(select).toHaveBeenCalledWith("beta/one");
  });
});
