import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SearchableSelectPage } from "../src/manager/searchable-select.ts";

// SAFETY: The pure selector renderer uses only these Theme methods.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const page = (height = 14, notice?: string) => {
  const select = vi.fn();
  const baseOptions = {
    theme,
    breadcrumb: "/profiles › reviewer › Primary › Model",
    title: "Choose model",
    subtitle: "[G] global · Local Pi",
    choices: [
      {
        value: "openai/model-one",
        item: {
          value: "openai/model-one",
          label: "openai/model-one",
          description: "Model One",
        },
        searchText: "openai model one",
        payload: "openai/model-one",
      },
      {
        value: "openai/model-two",
        item: {
          value: "openai/model-two",
          label: "openai/model-two",
          description: "Model Two",
        },
        searchText: "openai model two",
        payload: "openai/model-two",
      },
    ],
    current: "openai/model-one",
    getHeight: () => height,
    requestRender: vi.fn(),
    select,
    cancel: vi.fn(),
  };
  const component = new SearchableSelectPage<string>(
    notice ? { ...baseOptions, notice } : baseOptions,
  );
  return { component, select, options: baseOptions };
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

  it("preserves stable selection through detail toggles and a cleared filter", () => {
    const moved = page();
    moved.component.handleInput("\u001b[B");
    moved.component.handleInput("?");
    moved.component.handleInput("\r");
    expect(moved.select).toHaveBeenCalledWith("openai/model-two");

    const filtered = page();
    filtered.component.handleInput("/");
    filtered.component.handleInput("two");
    filtered.component.handleInput("\u001b");
    expect(filtered.component.searchState).toEqual({ query: "", active: false });
    filtered.component.handleInput("?");
    filtered.component.handleInput("\r");
    expect(filtered.select).toHaveBeenCalledWith("openai/model-one");
  });

  it("selects the visible match when confirmed inside search", () => {
    const filtered = page();
    filtered.component.handleInput("/");
    filtered.component.handleInput("two");
    filtered.component.handleInput("\r");

    expect(filtered.select).toHaveBeenCalledWith("openai/model-two");
    expect(filtered.component.selectedValue).toBe("openai/model-two");
  });

  it("keeps disabled rows visible without selecting them", () => {
    const select = vi.fn();
    const component = new SearchableSelectPage({
      theme,
      breadcrumb: "/models",
      title: "Choose model",
      subtitle: "",
      choices: [
        {
          value: "disabled",
          item: { value: "disabled", label: "Disabled model" },
          searchText: "disabled",
          payload: "disabled",
          enabled: false,
          disabledReason: "Unavailable in this runtime",
        },
      ],
      getHeight: () => 12,
      requestRender: vi.fn(),
      select,
      cancel: vi.fn(),
    });

    component.handleInput("\r");

    expect(select).not.toHaveBeenCalled();
    expect(component.render(80).join("\n")).toContain("Unavailable in this runtime");
  });

  it("keeps zero-height empty and reserves tiny heights for the frame", () => {
    const top = page(2, "Catalog warning").component.render(48);
    for (const height of [0, 1, 2]) {
      const fixture = page(height, "Catalog warning");
      fixture.component.handleInput("/");
      fixture.component.handleInput("two");
      const lines = fixture.component.render(48);
      expect(lines).toHaveLength(height);
      if (height > 0) expect(lines[0]).toBe(top[0]);
      expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
      expect(fixture.component.render(3)).toEqual(Array.from({ length: height }, () => "   "));
      fixture.component.handleInput("\r");
      expect(fixture.select).toHaveBeenCalledWith("openai/model-two");
    }
  });
  it("keeps compact and narrow output bounded", () => {
    const { component } = page();
    for (const width of [0, 1, 2, 3, 4, 24]) {
      const lines = component.render(width);
      if (width === 0) expect(lines).toEqual([]);
      else {
        expect(lines).toHaveLength(14);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }

    for (const height of [3, 4, 5, 6]) {
      const compact = page(height, "Catalog warning").component;
      compact.handleInput("/");
      compact.handleInput("two");
      const lines = compact.render(48);
      expect(lines).toHaveLength(height);
      expect(lines.every((line) => visibleWidth(line) <= 48)).toBe(true);
    }
  });
});
