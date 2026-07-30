import { describe, expect, it } from "vitest";
import { resolvePiModelSelector } from "../src/run/model-catalog.ts";

describe("profile model catalog", () => {
  it("resolves configured Pi profile selectors without picking among providers", () => {
    const available = [
      { provider: "openai", id: "gpt-5.5" },
      { provider: "openrouter", id: "gpt-5.5" },
      { provider: "anthropic", id: "claude-opus-5" },
    ];
    expect(resolvePiModelSelector("openai/gpt-5.5", available)).toEqual({
      kind: "resolved",
      provider: "openai",
      id: "gpt-5.5",
    });
    expect(resolvePiModelSelector("claude-opus-5", available)).toEqual({
      kind: "resolved",
      provider: "anthropic",
      id: "claude-opus-5",
    });
    expect(resolvePiModelSelector("gpt-5.5", available)).toEqual({
      kind: "ambiguous",
      candidates: ["openai/gpt-5.5", "openrouter/gpt-5.5"],
    });
    const unknown = resolvePiModelSelector("claude-opus", available);
    expect(unknown.kind).toBe("unknown");
    if (unknown.kind === "unknown")
      expect(unknown.nearMatches).toEqual(["anthropic/claude-opus-5"]);
  });
});
