import { describe, expect, it } from "vitest";
import { sanitizeTerminalLine, sanitizeTerminalText } from "../src/ui/sanitize.ts";

describe("terminal text sanitization", () => {
  it("removes ANSI, OSC, and control characters while retaining layout", () => {
    const value = sanitizeTerminalText(
      "\u001b[31mred\u001b[0m\u001b]0;owned\u0007\u009b31mhidden\u009b0m\u009dtitle\u009c\nnext\u0000",
    );
    expect(value).toBe("redhidden\nnext");
  });

  it("collapses process metadata to a single safe line", () => {
    expect(sanitizeTerminalLine("name\nnext\tvalue")).toBe("name next value");
  });
});
