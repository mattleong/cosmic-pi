import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  visibleWidth,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AskUserDialog } from "../src/ui/dialog.ts";
import type { AskUserRequest } from "../src/tools/schema.ts";

const request: AskUserRequest = {
  questions: [
    {
      key: "approach",
      title: "Approach",
      prompt: "Which implementation approach should we take?",
      mode: "single",
      choices: [
        {
          value: "safe",
          label: "Safe migration",
          description: "Make the smallest reversible change.",
        },
        { value: "rewrite", label: "Rewrite", description: "Replace the subsystem in one pass." },
      ],
    },
  ],
};

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const keybindings = {
  matches: (data: string, id: string) => {
    if (id === "tui.select.up") return matchesKey(data, Key.up);
    if (id === "tui.select.down") return matchesKey(data, Key.down);
    if (id === "tui.select.confirm") return matchesKey(data, Key.enter);
    if (id === "tui.select.cancel") return matchesKey(data, Key.escape);
    return false;
  },
} as unknown as KeybindingsManager;

const make = () => {
  const done = vi.fn();
  const requestRender = vi.fn();
  const dialog = new AskUserDialog({
    tui: { requestRender } as unknown as TUI,
    theme,
    keybindings,
    request,
    done,
    editExternally: () => Promise.resolve(undefined),
    onCollapse: vi.fn(),
  });
  return { dialog, done, requestRender };
};

describe("ask-user TUI", () => {
  it("renders width-safe layouts and submits a selected value", () => {
    const { dialog, done } = make();
    for (const width of [120, 48, 12]) {
      expect(dialog.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
    }

    dialog.handleInput("\r");
    expect(done).not.toHaveBeenCalled();
    dialog.handleInput("\r");
    expect(done).toHaveBeenCalledWith({
      outcome: "submitted",
      answers: [{ key: "approach", kind: "choices", values: ["safe"], labels: ["Safe migration"] }],
    });
  });

  it("collapses through the mounted overlay without a terminal input listener", () => {
    const { dialog } = make();
    const handle = {
      setHidden: vi.fn(),
      unfocus: vi.fn(),
      focus: vi.fn(),
      isHidden: vi.fn(),
      isFocused: vi.fn(),
      hide: vi.fn(),
    } as unknown as OverlayHandle;
    dialog.setOverlayHandle(handle);
    dialog.handleInput("b");
    expect(handle.setHidden).toHaveBeenCalledWith(true);
    expect(handle.unfocus).toHaveBeenCalledOnce();
    dialog.resume();
    expect(handle.setHidden).toHaveBeenCalledWith(false);
    expect(handle.focus).toHaveBeenCalledOnce();
  });
});
