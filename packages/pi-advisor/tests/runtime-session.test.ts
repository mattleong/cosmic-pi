import { describe, expect, it } from "vitest";
import { assistantTextAfterPrompt } from "../src/runtime/session.ts";

describe("advisor runtime session message decoding", () => {
  it("correlates schema-decoded messages while preserving mixed non-text parts", () => {
    const prompt = "Finalize the review";
    const messages: readonly unknown[] = [
      {
        role: "user",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "src/index.ts" } },
          { type: "text", text: prompt },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "internal" },
          { type: "text", text: "First finding" },
          { type: "image", data: "ignored" },
          { type: "text", text: "Second finding" },
        ],
      },
    ];

    expect(assistantTextAfterPrompt(messages, prompt)).toBe("First finding\nSecond finding");
  });
});
