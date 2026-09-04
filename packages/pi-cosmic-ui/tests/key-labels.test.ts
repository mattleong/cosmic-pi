import { describe, expect, it } from "vitest";
import {
  filterReservedKeyLabel,
  formatFullScreenKeyId,
  fullScreenKeybindingLabel,
} from "../src/manager/key-labels.ts";

describe("manager key labels", () => {
  it("formats special keys and printable modifiers", () => {
    expect(formatFullScreenKeyId("ctrl+u")).toBe("C-u");
    expect(formatFullScreenKeyId("shift+j")).toBe("⇧J");
    expect(formatFullScreenKeyId("pageDown")).toBe("PgDn");
  });

  it("uses configured labels before the fallback", () => {
    expect(fullScreenKeybindingLabel("tui.select.up", "↑", () => ["k", "up"])).toBe("k/↑");
    expect(fullScreenKeybindingLabel("tui.select.up", "↑", () => [])).toBe("↑");
  });

  it("removes reserved printable collisions without parsing ambiguous slash labels", () => {
    expect(filterReservedKeyLabel("j/↓", new Set(["j"]), "↓")).toBe("↓");
    expect(filterReservedKeyLabel("⇧J/G", new Set(["J"]), "G")).toBe("G");
    expect(filterReservedKeyLabel("/", new Set(["/"]), "filter")).toBe("filter");
    expect(filterReservedKeyLabel("j//↓", new Set(["j"]), "↓")).toBe("j//↓");
  });
});
