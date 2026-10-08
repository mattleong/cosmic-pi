import { describe, expect, it } from "vitest";
import { configuredKeyLabels, fullScreenKeybindingOptions } from "../src/manager/key-labels.ts";

describe("manager key labels", () => {
  it("adapts Pi keybindings and falls back to the default label without getKeys", () => {
    const keys = fullScreenKeybindingOptions({
      matches: (data) => data === "k",
      getKeys: () => ["k", "up"],
    });
    expect(keys.matchesKeybinding("k", "tui.select.up")).toBe(true);
    expect(keys.keybindingLabel("tui.select.up", "↑")).toBe("k/↑");
    const legacy = fullScreenKeybindingOptions({ matches: () => false });
    expect(legacy.keybindingLabel("tui.select.up", "↑")).toBe("↑");
    const unbound = fullScreenKeybindingOptions({ matches: () => false, getKeys: () => [] });
    expect(unbound.keybindingLabel("tui.select.up", "↑")).toBe("↑");
  });

  it("removes reserved printable collisions without parsing ambiguous slash labels", () => {
    const shown = (label: string, reserved: string, fallback: string) =>
      configuredKeyLabels(() => label, new Set([reserved])).key("tui.select.up", fallback);
    expect(shown("j/↓", "j", "↓")).toBe("↓");
    expect(shown("⇧J/G", "J", "G")).toBe("G");
    expect(shown("/", "/", "filter")).toBe("filter");
    expect(shown("j//↓", "j", "↓")).toBe("j//↓");
  });
});
