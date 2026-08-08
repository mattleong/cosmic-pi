import { describe, expect, it } from "vitest";
import {
  filterReservedKeyLabel,
  formatFullScreenKeyId,
  fullScreenKeybindingLabel,
} from "../src/manager/key-labels.ts";
import {
  FullScreenKeymap,
  pageSteps,
  type FullScreenResolution,
  type FullScreenSelectionKeybindingId,
} from "../src/manager/keymap.ts";
import {
  fullScreenSettingsHint,
  settingsHintRenderer,
  settingsSurfaceBridge,
  VimSettingsAdapter,
} from "../src/manager/settings-adapter.ts";

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
    expect(resolve("\u001b[5~")).toBe("full-page-up");
    expect(resolve("\u001b[6~")).toBe("full-page-down");
    expect(resolve("q")).toBe("quit");
    expect(resolve("/")).toBe("search");
  });

  it("keeps half-page and full-page motions distinct", () => {
    const keymap = new FullScreenKeymap();
    const resolve = (data: string) => resolvedAction(keymap.resolve(data, { mode: "navigation" }));

    expect(resolve("\u0015")).toBe("half-page-up");
    expect(resolve("\u0004")).toBe("half-page-down");
    expect(resolve("\u001b[5~")).toBe("full-page-up");
    expect(resolve("\u001b[6~")).toBe("full-page-down");
  });

  it("resolves configured selection page bindings to full-page actions", () => {
    const bindings: Partial<Record<FullScreenSelectionKeybindingId, string>> = {
      "tui.select.pageUp": "\u001b[5;5~",
      "tui.select.pageDown": "\u001b[6;5~",
    };
    const matchesKeybinding = (data: string, id: FullScreenSelectionKeybindingId) =>
      bindings[id] === data;
    const keymap = new FullScreenKeymap();
    expect(
      resolvedAction(keymap.resolve("\u001b[5;5~", { mode: "navigation", matchesKeybinding })),
    ).toBe("full-page-up");
    expect(
      resolvedAction(keymap.resolve("\u001b[6;5~", { mode: "navigation", matchesKeybinding })),
    ).toBe("full-page-down");
  });

  it("keeps printable configured page keys available to search text", () => {
    const matchesKeybinding = (data: string, id: FullScreenSelectionKeybindingId) =>
      (data === "u" && id === "tui.select.pageUp") ||
      (data === "d" && id === "tui.select.pageDown");
    const keymap = new FullScreenKeymap();
    for (const mode of ["search", "text-input"] as const) {
      expect(keymap.resolve("u", { mode, matchesKeybinding })).toBeUndefined();
      expect(keymap.resolve("d", { mode, matchesKeybinding })).toBeUndefined();
    }
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

  it("drops configured labels that collide with screen-reserved shortcuts", () => {
    const reserved = new Set(["m", "x"]);
    expect(filterReservedKeyLabel("m/↓", reserved, "↓")).toBe("↓");
    expect(filterReservedKeyLabel("m", reserved, "↓")).toBe("↓");
    expect(filterReservedKeyLabel("s/↓", reserved, "↓")).toBe("s/↓");
    expect(filterReservedKeyLabel("⇧M/Enter", reserved, "Enter")).toBe("⇧M/Enter");
  });

  it("drops shift-modified labels whose effective printable is screen-reserved", () => {
    const reserved = new Set(["J", "K", "X", "x"]);
    expect(filterReservedKeyLabel("⇧J/↓", reserved, "↓")).toBe("↓");
    expect(filterReservedKeyLabel("⇧K", reserved, "↑")).toBe("↑");
    expect(filterReservedKeyLabel("⇧X/Enter", reserved, "Enter")).toBe("Enter");
    // Case-sensitive: shift+m produces "M", which is not reserved here.
    expect(filterReservedKeyLabel("⇧M/Enter", reserved, "Enter")).toBe("⇧M/Enter");
    // Shift-modified special keys keep their labels intact.
    expect(filterReservedKeyLabel("⇧Tab/↓", reserved, "↓")).toBe("⇧Tab/↓");
  });

  it("treats a configured bare slash safely and defers ambiguous slash-separated labels", () => {
    const reserved = new Set(["/", "m"]);
    expect(filterReservedKeyLabel("/", reserved, "↑")).toBe("↑");
    expect(filterReservedKeyLabel("/", new Set(["m"]), "↑")).toBe("/");
    // A "/" key inside a multi-key label is indistinguishable from the label separator in the
    // current display representation; the label is deliberately left unchanged (deferred edge).
    expect(filterReservedKeyLabel("j//", reserved, "↓")).toBe("j//");
    expect(filterReservedKeyLabel("//↓", reserved, "↓")).toBe("//↓");
    // Normal multi-key labels keep their separators and unreserved parts.
    expect(filterReservedKeyLabel("j/↓", reserved, "↓")).toBe("j/↓");
    expect(filterReservedKeyLabel("m/j/↓", reserved, "↓")).toBe("j/↓");
  });

  it("produces modeless contextual hints without mode labels", () => {
    const collapsed = fullScreenSettingsHint({ searching: false, search: true });
    const expanded = fullScreenSettingsHint({ searching: false, search: true, helpExpanded: true });
    const searching = fullScreenSettingsHint({ searching: true, search: true });
    const noSearch = fullScreenSettingsHint({ searching: false });

    expect(collapsed).toBe("j/k move · Enter/l select · h/q back · / filter · ? help");
    expect(expanded).toContain("C-u/d/PgUp/PgDn page");
    expect(expanded).toContain("? less");
    expect(searching).toBe("Type to filter · Enter select · Esc done");
    expect(noSearch).not.toContain("/ filter");
    for (const hint of [collapsed, expanded, searching, noSearch]) {
      expect(hint).not.toMatch(/NORMAL|INSERT|SEARCH|CONFIRM|BUSY/);
    }
  });

  it("does not advertise a half/full page distinction SettingsList cannot honor", () => {
    const expanded = fullScreenSettingsHint({ searching: false, search: true, helpExpanded: true });
    expect(expanded).not.toContain("half-page");
    expect(expanded).not.toContain("C-u/d half");
  });

  it("renders shared settings hints from the adapter mode via settingsHintRenderer", () => {
    const dim = (text: string) => `<${text}>`;
    const withSearch = settingsHintRenderer({ dim, search: true });
    const withoutSearch = settingsHintRenderer({ dim });

    expect(withSearch("navigation")).toBe(
      `< ${fullScreenSettingsHint({ searching: false, search: true })} >`,
    );
    expect(withSearch("navigation", true)).toBe(
      `< ${fullScreenSettingsHint({ searching: false, search: true, helpExpanded: true })} >`,
    );
    expect(withSearch("search")).toBe("< Type to filter · Enter select · Esc done >");
    expect(withoutSearch("navigation")).not.toContain("/ filter");
  });

  it("computes clamped page steps shared by full-screen list surfaces", () => {
    expect(pageSteps(9)).toEqual({ page: 9, half: 4 });
    expect(pageSteps(2)).toEqual({ page: 2, half: 1 });
    expect(pageSteps(1)).toEqual({ page: 1, half: 1 });
    expect(pageSteps(0)).toEqual({ page: 1, half: 1 });
    expect(pageSteps(-5)).toEqual({ page: 1, half: 1 });
  });

  it("bridges focus to the adapter and rendering to the container", () => {
    const received: string[] = [];
    const child = {
      render: () => ["settings"],
      handleInput: (data: string) => received.push(data),
      invalidate: () => undefined,
    };
    const adapter = new VimSettingsAdapter(child);
    let invalidated = 0;
    const container = {
      render: (width: number) => [`title:${width}`, ...child.render()],
      invalidate: () => {
        invalidated += 1;
      },
    };
    const afterInput: string[] = [];
    const bridge = settingsSurfaceBridge(adapter, container, {
      afterInput: () => afterInput.push("after"),
    });

    bridge.focused = true;
    expect(adapter.focused).toBe(true);
    expect(bridge.focused).toBe(true);
    expect(bridge.render(12)).toEqual(["title:12", "settings"]);
    bridge.handleInput?.("j");
    expect(received).toEqual([`${String.fromCharCode(27)}[B`]);
    expect(afterInput).toEqual(["after"]);
    bridge.invalidate();
    expect(invalidated).toBe(1);
  });

  it("routes bridged callbacks through the caller-owned host guard with fallbacks", () => {
    const child = {
      render: () => ["settings"],
      handleInput: () => undefined,
      invalidate: () => undefined,
    };
    const adapter = new VimSettingsAdapter(child);
    const hostile = {
      render: (): string[] => {
        throw new Error("hostile render");
      },
      invalidate: (): void => {
        throw new Error("hostile invalidate");
      },
    };
    const guarded: string[] = [];
    const bridge = settingsSurfaceBridge(adapter, hostile, {
      invoke: (callback, fallback) => {
        guarded.push("invoke");
        try {
          return callback();
        } catch {
          return fallback;
        }
      },
    });

    expect(bridge.render(10)).toEqual([]);
    expect(() => bridge.invalidate()).not.toThrow();
    expect(() => bridge.handleInput?.("j")).not.toThrow();
    expect(guarded).toEqual(["invoke", "invoke", "invoke"]);
  });

  it("toggles expanded adapter help with ? and translates full-page motions", () => {
    const received: string[] = [];
    const hints: Array<boolean | undefined> = [];
    const child = {
      render: () => ["settings"],
      handleInput: (data: string) => received.push(data),
      invalidate: () => undefined,
    };
    const adapter = new VimSettingsAdapter(child, {
      renderHint: (_mode, helpExpanded) => {
        hints.push(helpExpanded);
        return "hint";
      },
    });
    adapter.render(20);
    adapter.handleInput("?");
    adapter.render(20);
    adapter.handleInput("?");
    adapter.render(20);
    expect(hints).toEqual([false, true, false]);
    expect(received).toEqual([]);

    adapter.handleInput("\u001b[5~");
    adapter.handleInput("\u001b[6~");
    expect(received).toEqual(["\u001b[5~", "\u001b[6~"]);
  });
});
