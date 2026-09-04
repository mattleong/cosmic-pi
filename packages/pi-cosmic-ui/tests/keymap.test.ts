import { describe, expect, it } from "vitest";
import { decodeFullScreenPrintable, FullScreenKeymap, pageSteps } from "../src/manager/keymap.ts";

const ENTER = "\r";
const ESC = "\x1b";
const UP = "\x1b[A";

describe("FullScreenKeymap", () => {
  it("keeps screen-owned shortcuts ahead of configured movement", () => {
    const keymap = new FullScreenKeymap();
    expect(
      keymap.resolve("x", {
        mode: "navigation",
        reservedKeys: new Set(["x"]),
        matchesKeybinding: (data, id) => data === "x" && id === "tui.select.down",
      }),
    ).toEqual({ _tag: "Shortcut", key: "x" });
  });

  it("resolves shared navigation and confirmation semantics", () => {
    const keymap = new FullScreenKeymap();
    expect(keymap.resolve("j", { mode: "navigation" })).toMatchObject({ action: "down" });
    expect(keymap.resolve(UP, { mode: "navigation" })).toMatchObject({ action: "up" });
    expect(keymap.resolve("/", { mode: "navigation" })).toMatchObject({ action: "search" });
    expect(keymap.resolve(ENTER, { mode: "confirmation" })).toMatchObject({ action: "confirm" });
    expect(keymap.resolve(ESC, { mode: "confirmation" })).toMatchObject({ action: "cancel" });
  });

  it("keeps busy, confirmation, and text-input modes isolated", () => {
    const keymap = new FullScreenKeymap();
    expect(keymap.resolve("j", { mode: "busy" })).toBeUndefined();
    expect(keymap.resolve("q", { mode: "busy" })).toMatchObject({ action: "quit" });
    expect(keymap.resolve("q", { mode: "confirmation" })).toMatchObject({ action: "cancel" });
    expect(keymap.resolve("j", { mode: "text-input" })).toBeUndefined();
  });

  it("ignores every repeated confirmation input and rejects DEL as printable", () => {
    const keymap = new FullScreenKeymap();
    expect(keymap.resolve("\x1b[13;1:2u", { mode: "confirmation" })).toBeUndefined();
    expect(
      keymap.resolve("\x1b[120;1:2u", {
        mode: "confirmation",
        reservedKeys: new Set(["x"]),
      }),
    ).toBeUndefined();
    expect(decodeFullScreenPrintable("\x7f")).toBeUndefined();
  });

  it("keeps shared printable actions ahead of configured movement bindings", () => {
    const keymap = new FullScreenKeymap();
    const matchesKeybinding = (data: string, id: string) =>
      data === "q" && id === "tui.select.down";

    expect(keymap.resolve("q", { mode: "navigation", matchesKeybinding })).toMatchObject({
      action: "quit",
    });
  });

  it("lets printable input belong to search and supports the gg chord", () => {
    const keymap = new FullScreenKeymap();
    expect(keymap.resolve("j", { mode: "search" })).toBeUndefined();
    expect(keymap.resolve("g", { mode: "navigation" })).toMatchObject({ action: "pending-first" });
    expect(keymap.resolve("g", { mode: "navigation" })).toMatchObject({ action: "first" });
  });

  it("clamps page motion to at least one row", () => {
    expect(pageSteps(0)).toEqual({ page: 1, half: 1 });
    expect(pageSteps(9)).toEqual({ page: 9, half: 4 });
  });
});
