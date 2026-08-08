import type { Theme } from "@earendil-works/pi-coding-agent";
import { pageSteps } from "pi-cosmic-ui/manager/keybindings";
import { describe, expect, it, vi } from "vitest";
import {
  nextSearchableSelectIndex,
  SearchableSelectPage,
  type SearchableSelectMotion,
} from "../src/settings/ui/searchable-select-page.ts";

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
    initialSearchMode?: boolean;
    notice?: string;
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
    initialSearchMode: options.initialSearchMode,
    notice: options.notice,
    getHeight: () => options.height ?? 20,
    requestRender: vi.fn(),
    matchesKeybinding: options.matchesKeybinding,
    keybindingLabel: options.keybindingLabel,
    select: options.select ?? vi.fn(),
    cancel: options.cancel ?? vi.fn(),
  });

describe("searchable settings selector", () => {
  it("shows modeless filter hints without mode labels", () => {
    const selector = page([choice("a", "Model alpha", "alpha")]);
    const idle = selector.render(80).join("\n");
    expect(idle).toContain("Press / to filter");
    expect(idle).not.toMatch(/NORMAL|INSERT/);

    selector.handleInput("/");
    const searching = selector.render(80).join("\n");
    expect(searching).toContain("Type to filter · Enter select · Esc done");
    expect(searching).toContain("Esc Done");
    expect(searching).not.toMatch(/NORMAL|INSERT/);
  });

  it("toggles expanded contextual help with ?", () => {
    const selector = page([choice("a", "Model alpha", "alpha")]);
    expect(selector.render(90).at(-1)).toContain("? Help");
    selector.handleInput("?");
    const expanded = selector.render(90).at(-1) ?? "";
    expect(expanded).toContain("PgUp/PgDn");
    expect(expanded).toContain("? Less");
    selector.handleInput("?");
    expect(selector.render(90).at(-1)).toContain("? Help");
  });

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
    selector.handleInput("/");
    for (const character of "model") selector.handleInput(character);
    selector.handleInput("\r");
    expect(select).toHaveBeenCalledWith("gamma");
  });

  it("shows feedback when Enter has no matching selection", () => {
    const selector = page([choice("a", "Model alpha", "alpha")]);
    selector.handleInput("/");
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

  it("keeps warnings visible in compact and wrapped selector layouts", () => {
    const notice =
      "The configured model catalog could not be loaded, so safe fallback choices are shown instead.";
    const compact = page([choice("a", "Model alpha", "alpha")], { height: 4, notice });
    expect(compact.render(50).join("\n")).toContain("configured model catalog");
    expect(compact.render(50).join("\n")).toContain("Model alpha");

    const wrapped = page([choice("a", "Model alpha", "alpha")], { height: 14, notice });
    const rendered = wrapped.render(34).join("\n");
    expect(rendered).toContain("configured model");
    expect(rendered).toContain("fallback choices");
    expect(wrapped.render(34).at(-1)).toContain("q Back");
    expect(wrapped.render(20).at(-1)).toContain("q Back");

    const oneRow = page([choice("a", "Model alpha", "alpha")], { height: 1, notice });
    expect(oneRow.render(30)).toHaveLength(1);
  });

  it("computes wrap-around row motions and clamped page motions purely", () => {
    const steps = pageSteps(9);
    const next = (motion: SearchableSelectMotion, current: number) =>
      nextSearchableSelectIndex(motion, current, 20, steps);

    expect(next("up", 0)).toBe(19);
    expect(next("up", 5)).toBe(4);
    expect(next("down", 19)).toBe(0);
    expect(next("down", 5)).toBe(6);
    expect(next("half-page-up", 2)).toBe(0);
    expect(next("half-page-up", 10)).toBe(6);
    expect(next("half-page-down", 18)).toBe(19);
    expect(next("half-page-down", 10)).toBe(14);
    expect(next("full-page-up", 4)).toBe(0);
    expect(next("full-page-up", 15)).toBe(6);
    expect(next("full-page-down", 15)).toBe(19);
    expect(next("full-page-down", 5)).toBe(14);
    expect(next("first", 12)).toBe(0);
    expect(next("last", 3)).toBe(19);
  });

  it("supports Home, End, half-page, and full-page navigation", () => {
    const select = vi.fn();
    const choices = Array.from({ length: 20 }, (_, index) =>
      choice(String(index), `Model ${index}`, String(index)),
    );
    const selector = page(choices, { select });
    selector.handleInput("\u001b[H");
    selector.handleInput("\u001b[6~");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("9");

    selector.handleInput("\u0004");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("13");

    selector.handleInput("\u001b[F");
    selector.handleInput("\u001b[5~");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("10");

    selector.handleInput("\u001b[H");
    selector.handleInput("\u0004");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("4");
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
    const footer = selector.render(100).at(-1) ?? "";
    expect(footer).toContain("j/k · P/N Navigate");
    expect(footer).toContain("l/Y Select · h/q/Q Back");
  });

  it("keeps Vim keys typeable in search mode and supports gg/G in navigation", () => {
    const select = vi.fn();
    const selector = page(
      [
        choice("a", "Model alpha", "alpha"),
        choice("b", "Model beta", "beta"),
        choice("c", "Model gamma", "gamma"),
      ],
      { select },
    );
    selector.handleInput("G");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("gamma");
    selector.handleInput("g");
    selector.handleInput("g");
    selector.handleInput("\r");
    expect(select).toHaveBeenLastCalledWith("alpha");

    selector.handleInput("/");
    for (const character of "hjklqgGs") selector.handleInput(character);
    expect(selector.render(100).join("\n")).toContain("hjklqgGs");
  });

  it("preselects the current filtered choice and honors configured keybindings", () => {
    const select = vi.fn();
    const cancel = vi.fn();
    const selector = page(
      [choice("a", "Model alpha", "alpha"), choice("b", "Model beta", "beta")],
      {
        current: "b",
        initialQuery: "model",
        initialSearchMode: false,
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
