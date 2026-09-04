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
  return { component, select };
};

describe("searchable selector state", () => {
  it("preserves selection through detail toggles and filtering", () => {
    const moved = page();
    moved.component.handleInput("\u001b[B");
    moved.component.handleInput("?");
    moved.component.handleInput("\r");
    expect(moved.select).toHaveBeenCalledWith("openai/model-two");

    const filtered = page();
    filtered.component.handleInput("/");
    filtered.component.handleInput("two");
    filtered.component.handleInput("\u001b");
    filtered.component.handleInput("?");
    filtered.component.handleInput("\r");
    expect(filtered.select).toHaveBeenCalledWith("openai/model-two");
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
