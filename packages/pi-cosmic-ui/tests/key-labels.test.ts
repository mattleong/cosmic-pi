import { describe, expect, it } from "vitest";
import {
  filterReservedKeyLabel,
  fullScreenKeybindingLabel,
  fullScreenKeybindingOptions,
} from "../src/manager/key-labels.ts";

describe("manager key labels", () => {
  it("uses configured labels before the fallback", () => {
    expect(fullScreenKeybindingLabel("tui.select.up", "↑", () => ["k", "up"])).toBe("k/↑");
    expect(fullScreenKeybindingLabel("tui.select.up", "↑", () => [])).toBe("↑");
  });

  it("adapts Pi keybindings and falls back to the default label without getKeys", () => {
    const keys = fullScreenKeybindingOptions({
      matches: (data) => data === "k",
      getKeys: () => ["k", "up"],
    });
    expect(keys.matchesKeybinding("k", "tui.select.up")).toBe(true);
    expect(keys.keybindingLabel("tui.select.up", "↑")).toBe("k/↑");
    const legacy = fullScreenKeybindingOptions({ matches: () => false });
    expect(legacy.keybindingLabel("tui.select.up", "↑")).toBe("↑");
  });

  it("removes reserved printable collisions without parsing ambiguous slash labels", () => {
    expect(filterReservedKeyLabel("j/↓", new Set(["j"]), "↓")).toBe("↓");
    expect(filterReservedKeyLabel("⇧J/G", new Set(["J"]), "G")).toBe("G");
    expect(filterReservedKeyLabel("/", new Set(["/"]), "filter")).toBe("filter");
    expect(filterReservedKeyLabel("j//↓", new Set(["j"]), "↓")).toBe("j//↓");
  });
});
