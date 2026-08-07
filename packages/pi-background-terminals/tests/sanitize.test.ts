import { describe, expect, it } from "vitest";
import { sanitizeTerminalLine } from "../src/ui/sanitize.ts";

describe("terminal text sanitization", () => {
  it("collapses process metadata to a single safe line", () => {
    expect(sanitizeTerminalLine("name\nnext\tvalue")).toBe("name next value");
  });
});
