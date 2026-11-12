import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
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

const grouped = (value: string, group?: string) => ({
  value,
  item: { value, label: value },
  searchText: value,
  payload: value,
  group,
});

const groupedPage = (height = 20, overrides: { readonly initialSearchMode?: boolean } = {}) => {
  const fixture = page(height);
  const component = new SearchableSelectPage<string>({
    ...fixture.options,
    choices: [
      grouped("beta/one", "beta"),
      grouped("alpha/one", "alpha"),
      grouped("beta/two", "beta"),
      grouped("inherit"),
      grouped("alpha/two", "alpha"),
    ],
    current: undefined,
    ...overrides,
  });
  const screen = () => Arr.join(component.render(60), "\n");
  return { component, select: fixture.select, screen };
};

describe("grouped choices", () => {
  it("lists ungrouped choices first, then each group together under one heading", () => {
    const { screen } = groupedPage();
    const lines = Str.split(screen(), "\n");
    const at = (text: string) =>
      Option.getOrElse(Arr.findFirstIndex(lines, Str.includes(text)), () => -1);
    expect(at("inherit")).toBeLessThan(at("beta/one"));
    expect(at("beta/one")).toBeLessThan(at("beta/two"));
    expect(at("beta/two")).toBeLessThan(at("alpha/one"));
    expect(Arr.filter(lines, (line) => /^│\s*beta\s*│$/u.test(line))).toHaveLength(1);
  });

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
