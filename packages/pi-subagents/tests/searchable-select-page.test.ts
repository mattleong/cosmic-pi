import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SearchableSelectPage } from "../src/settings/ui/searchable-select-page.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const choice = (value: string, label: string, payload: string) => ({
  value,
  item: { value, label },
  searchText: label,
  payload,
});

const page = (
  choices: ReturnType<typeof choice>[],
  options: {
    current?: string;
    initialQuery?: string;
    select?: (payload: string) => void;
    cancel?: () => void;
    matchesKeybinding?: (data: string, id: string) => boolean;
    keybindingLabel?: (id: string, fallback: string) => string;
    height?: number;
  } = {},
) =>
  new SearchableSelectPage<string>({
    theme,
    breadcrumb: "Settings › choose",
    title: "Choose value",
    subtitle: "Fixture",
    choices,
    current: options.current,
    initialQuery: options.initialQuery,
    getHeight: () => options.height ?? 20,
    requestRender: vi.fn(),
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: options.select ?? vi.fn(),
    cancel: options.cancel ?? vi.fn(),
  });

describe("searchable settings selector", () => {
  it("selects the exact filtered item when values collide", () => {
    const select = vi.fn();
    const selector = page(
      [choice("same", "First model", "first"), choice("same", "Second model", "second")],
      { initialQuery: "second", select },
    );
    selector.handleInput("\r");
    expect(select).toHaveBeenCalledWith("second");
  });

  it("preserves the highlighted match while the query changes", () => {
    const select = vi.fn();
    const selector = page(
      [
        choice("a", "Model alpha", "alpha"),
        choice("b", "Model beta", "beta"),
        choice("c", "Model gamma", "gamma"),
      ],
      { current: "b", select },
    );
    selector.handleInput("\u001b[B");
    for (const character of "model") selector.handleInput(character);
    selector.handleInput("\r");
    expect(select).toHaveBeenCalledWith("gamma");
  });

  it("shows feedback when Enter has no matching selection", () => {
    const selector = page([choice("a", "Model alpha", "alpha")]);
    for (const character of "zzz") selector.handleInput(character);
    selector.handleInput("\r");
    expect(selector.render(80).join("\n")).toContain("change the search or go back");
  });

  it("keeps search and a selectable row visible in very short terminals", () => {
    const selector = page([choice("a", "Model alpha", "alpha")], { height: 4 });
    const rendered = selector.render(50);
    expect(rendered).toHaveLength(4);
    expect(rendered.join("\n")).toContain("Model alpha");
  });

  it("supports Home, End, PageUp, and PageDown list navigation", () => {
    const select = vi.fn();
    const choices = Array.from({ length: 20 }, (_, index) =>
      choice(String(index), `Model ${index}`, String(index)),
    );
    const selector = page(choices, { select });
    selector.handleInput("\u001b[F");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("19");

    selector.handleInput("\u001b[H");
    selector.handleInput("\u001b[6~");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("9");
    selector.handleInput("\u001b[5~");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("0");
  });

  it("renders configured keybinding labels instead of fixed defaults", () => {
    const selector = page([choice("a", "Model alpha", "alpha")], {
      keybindingLabel: (id, fallback) =>
        ({
          "tui.select.up": "P",
          "tui.select.down": "N",
          "tui.select.confirm": "Y",
          "tui.select.cancel": "Q",
        })[id] ?? fallback,
    });
    expect(selector.render(100).at(-1)).toContain("P/N navigate · Y select · Q back");
  });

  it("preselects the current filtered choice and honors configured keybindings", () => {
    const select = vi.fn();
    const cancel = vi.fn();
    const selector = page(
      [choice("a", "Model alpha", "alpha"), choice("b", "Model beta", "beta")],
      {
        current: "b",
        initialQuery: "model",
        select,
        cancel,
        matchesKeybinding: (data, id) =>
          (data === "Y" && id === "tui.select.confirm") ||
          (data === "Q" && id === "tui.select.cancel"),
      },
    );
    selector.handleInput("Y");
    expect(select).toHaveBeenCalledWith("beta");
    selector.handleInput("Q");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
