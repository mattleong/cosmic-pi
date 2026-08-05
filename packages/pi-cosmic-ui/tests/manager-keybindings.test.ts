import { describe, expect, it } from "vitest";
import {
  formatFullScreenKeyId,
  FullScreenKeymap,
  fullScreenKeybindingLabel,
  VimSettingsAdapter,
  type FullScreenResolution,
  type FullScreenSelectionKeybindingId,
} from "../src/manager/keybindings.ts";

const resolvedAction = (resolution: FullScreenResolution | undefined) =>
  resolution?._tag === "Action" ? resolution.action : resolution?._tag;

describe("shared full-screen keymap", () => {
  it("resolves Vim navigation and compatibility keys", () => {
    const keymap = new FullScreenKeymap();
    const resolve = (data: string) => resolvedAction(keymap.resolve(data, { mode: "navigation" }));

    expect(resolve("k")).toBe("up");
    expect(resolve("j")).toBe("down");
    expect(resolve("h")).toBe("back");
    expect(resolve("l")).toBe("forward");
    expect(resolve("\u0015")).toBe("half-page-up");
    expect(resolve("\u0004")).toBe("half-page-down");
    expect(resolve("\u001b[H")).toBe("first");
    expect(resolve("\u001b[F")).toBe("last");
    expect(resolve("\u001b[5~")).toBeUndefined();
    expect(resolve("\u001b[6~")).toBeUndefined();
    expect(resolve("q")).toBe("quit");
    expect(resolve("/")).toBe("search");
  });

  it("supports gg and G with raw and Kitty printable input", () => {
    const keymap = new FullScreenKeymap();
    expect(resolvedAction(keymap.resolve("g", { mode: "navigation" }))).toBe("pending-first");
    expect(resolvedAction(keymap.resolve("g", { mode: "navigation" }))).toBe("first");
    expect(resolvedAction(keymap.resolve("G", { mode: "navigation" }))).toBe("last");
    expect(resolvedAction(keymap.resolve("\u001b[71u", { mode: "navigation" }))).toBe("last");
  });

  it("does not complete gg from a Kitty repeat event", () => {
    const keymap = new FullScreenKeymap();
    keymap.resolve("\u001b[103;1u", { mode: "navigation" });
    expect(keymap.resolve("\u001b[103;1:2u", { mode: "navigation" })).toBeUndefined();
    expect(resolvedAction(keymap.resolve("\u001b[103;1u", { mode: "navigation" }))).toBe("first");
  });

  it("keeps printable Vim keys available to search and text inputs", () => {
    const keymap = new FullScreenKeymap();
    for (const mode of ["search", "text-input"] as const) {
      for (const key of "hjklqgGs") expect(keymap.resolve(key, { mode })).toBeUndefined();
    }
  });

  it("honors configured selection keys and protects reserved commands", () => {
    const bindings: Partial<Record<FullScreenSelectionKeybindingId, string>> = {
      "tui.select.down": "s",
      "tui.select.confirm": "o",
      "tui.select.cancel": "x",
    };
    const matchesKeybinding = (data: string, id: FullScreenSelectionKeybindingId) =>
      bindings[id] === data;
    const keymap = new FullScreenKeymap();

    expect(resolvedAction(keymap.resolve("o", { mode: "navigation", matchesKeybinding }))).toBe(
      "confirm",
    );
    expect(resolvedAction(keymap.resolve("\r", { mode: "navigation", matchesKeybinding }))).toBe(
      "confirm",
    );
    expect(
      resolvedAction(keymap.resolve("\u001b[B", { mode: "navigation", matchesKeybinding })),
    ).toBe("down");
    expect(
      resolvedAction(keymap.resolve("\u001b", { mode: "navigation", matchesKeybinding })),
    ).toBe("cancel");
    expect(
      keymap.resolve("s", {
        mode: "navigation",
        matchesKeybinding,
        reservedKeys: new Set(["s"]),
      }),
    ).toEqual({ _tag: "Shortcut", key: "s" });
    expect(
      keymap.resolve("x", {
        mode: "confirmation",
        matchesKeybinding,
        reservedKeys: new Set(["x"]),
      }),
    ).toEqual({ _tag: "Shortcut", key: "x" });
    expect(
      keymap.resolve("\u001b[120;1:2u", {
        mode: "confirmation",
        matchesKeybinding,
        reservedKeys: new Set(["x"]),
      }),
    ).toBeUndefined();
  });

  it("lets text modes own printable configured selection keys", () => {
    const matchesKeybinding = (data: string, id: FullScreenSelectionKeybindingId) =>
      (data === "j" && id === "tui.select.down") ||
      (data === "q" && id === "tui.select.cancel") ||
      (data === "l" && id === "tui.select.confirm");
    const keymap = new FullScreenKeymap();
    for (const mode of ["search", "text-input"] as const) {
      expect(keymap.resolve("j", { mode, matchesKeybinding })).toBeUndefined();
      expect(keymap.resolve("q", { mode, matchesKeybinding })).toBeUndefined();
      expect(keymap.resolve("l", { mode, matchesKeybinding })).toBeUndefined();
      expect(resolvedAction(keymap.resolve("\u001b", { mode, matchesKeybinding }))).toBe("cancel");
      expect(resolvedAction(keymap.resolve("\r", { mode, matchesKeybinding }))).toBe("confirm");
    }
  });

  it("restricts confirmation and busy modes", () => {
    const keymap = new FullScreenKeymap();
    expect(resolvedAction(keymap.resolve("q", { mode: "confirmation" }))).toBe("cancel");
    expect(resolvedAction(keymap.resolve("\r", { mode: "confirmation" }))).toBe("confirm");
    expect(keymap.resolve("j", { mode: "confirmation" })).toBeUndefined();
    expect(keymap.resolve("j", { mode: "busy" })).toBeUndefined();
  });

  it("adapts SettingsList input without stealing search text", () => {
    const received: string[] = [];
    const child = {
      render: () => ["settings"],
      handleInput: (data: string) => received.push(data),
      invalidate: () => undefined,
    };
    const adapter = new VimSettingsAdapter(child, { search: true });
    adapter.handleInput("j");
    adapter.handleInput("l");
    adapter.handleInput("/");
    for (const key of "hjklqgGs") adapter.handleInput(key);
    adapter.handleInput("\u001b");
    adapter.handleInput("q");

    expect(received).toEqual(["\u001b[B", "\r", ..."hjklqgGs", "\u001b"]);

    const confirmReceived: string[] = [];
    const searchInput = { focused: false };
    const confirmingChild = {
      searchInput,
      submenuComponent: null,
      render: () => ["setting", "", "  Type to…"],
      handleInput: (data: string) => confirmReceived.push(data),
      invalidate: () => undefined,
    };
    const confirming = new VimSettingsAdapter(confirmingChild, {
      search: true,
      renderHint: () => "modal hint",
    });
    confirming.focused = true;
    expect(searchInput.focused).toBe(false);
    confirming.handleInput("/");
    expect(searchInput.focused).toBe(true);
    expect(confirming.render(12)).toEqual(["setting", "", "modal hint"]);
    expect(new VimSettingsAdapter(confirmingChild).render(12)).toEqual([
      "setting",
      "",
      "  Type to…",
    ]);
    confirming.handleInput("x");
    confirming.handleInput("\r");
    expect(searchInput.focused).toBe(false);
    confirming.handleInput("j");
    expect(confirmReceived).toEqual(["x", "\r", "\u001b[B"]);
  });

  it("formats configured labels without uppercasing plain letters", () => {
    expect(formatFullScreenKeyId("j")).toBe("j");
    expect(formatFullScreenKeyId("shift+g")).toBe("⇧G");
    expect(formatFullScreenKeyId("ctrl+pageDown")).toBe("C-PgDn");
    expect(fullScreenKeybindingLabel("tui.select.down", "↓", () => ["j", "down"])).toBe("j/↓");
  });
});
