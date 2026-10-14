import { describe, expect, it } from "vitest";
import { toolOutputPreview, TOOL_PREVIEW_LINES } from "../src/backend/tool-output-preview.ts";
import { addUsage } from "../src/run/state.ts";
import { emptyUsage } from "../src/run/model.ts";

describe("tool output preview", () => {
  it("reads the output shapes Pi, Claude, and Codex report", () => {
    expect(toolOutputPreview({ content: [{ type: "text", text: "pi output" }] })).toBe("pi output");
    expect(toolOutputPreview([{ type: "text", text: "claude" }, { type: "image" }])).toBe("claude");
    expect(toolOutputPreview("codex output\n")).toBe("codex output");
    expect(toolOutputPreview({ details: 1 })).toBeUndefined();
    expect(toolOutputPreview("   ")).toBeUndefined();
  });

  it("keeps only the first lines and marks the cut", () => {
    const text = Array.from({ length: 20 }, (_, line) => `line ${line}`).join("\n");
    const preview = toolOutputPreview(text) ?? "";
    expect(preview.split("\n")).toHaveLength(TOOL_PREVIEW_LINES);
    expect(preview.endsWith("…")).toBe(true);
    expect(toolOutputPreview("x".repeat(5_000))?.length).toBeLessThanOrEqual(1_001);
  });
});

describe("context usage", () => {
  it("keeps the latest reported context share instead of summing it", () => {
    const first = addUsage(emptyUsage(), {
      ...emptyUsage(),
      input: 10,
      totalTokens: 10,
      contextPercent: 40,
    });
    const second = addUsage(first, {
      ...emptyUsage(),
      input: 5,
      totalTokens: 5,
      contextPercent: 55,
    });
    expect(second.contextPercent).toBe(55);
    expect(addUsage(second, { ...emptyUsage(), output: 1, totalTokens: 1 }).contextPercent).toBe(
      55,
    );
  });
});
