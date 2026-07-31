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
    getHeight: () => 20,
    requestRender: vi.fn(),
    matchesKeybinding: options.matchesKeybinding,
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
