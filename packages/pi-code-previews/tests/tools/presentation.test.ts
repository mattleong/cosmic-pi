import { describe, expect, it } from "vitest";
import { getCodePreviewToolIcon } from "../../src/tools/presentation";

describe("getCodePreviewToolIcon", () => {
  it("returns the canonical standalone-call emoji for every supported built-in tool", () => {
    expect(
      Object.fromEntries(
        ["bash", "read", "write", "edit", "grep", "find", "ls"].map((tool) => [
          tool,
          getCodePreviewToolIcon(tool),
        ]),
      ),
    ).toEqual({
      bash: "🔧",
      read: "📖",
      write: "✏️",
      edit: "✂️",
      grep: "🔎",
      find: "🎯",
      ls: "📂",
    });
  });

  it("returns undefined for unsupported or qualified tool names", () => {
    expect(getCodePreviewToolIcon("custom_tool")).toBeUndefined();
    expect(getCodePreviewToolIcon("pi.read")).toBeUndefined();
  });
});
