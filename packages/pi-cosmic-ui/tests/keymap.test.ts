import { describe, expect, it } from "vitest";
import { decodeFullScreenPrintable, FullScreenKeymap } from "../src/manager/keymap.ts";

describe("FullScreenKeymap", () => {
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
});
