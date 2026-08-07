import { describe, expect, it } from "vitest";
import { SUBAGENT_FAST_SERVICE_TIER, supportsSubagentFastMode } from "../src/run/fast-mode.ts";

describe("OpenAI subagent fast mode", () => {
  it("uses the priority service tier for the shared supported OpenAI model set", () => {
    expect(SUBAGENT_FAST_SERVICE_TIER).toBe("priority");
    expect(supportsSubagentFastMode("pi", "openai-codex/gpt-5.6-sol")).toBe(true);
    expect(supportsSubagentFastMode("pi", "anthropic/claude-opus-4-6")).toBe(false);
    expect(supportsSubagentFastMode("claude", "claude-opus-4-6")).toBe(false);
  });

  it("lets authenticated Codex discovery and launch confirmation decide model-specific support", () => {
    expect(supportsSubagentFastMode("codex", "gpt-5.6-sol")).toBe(true);
    expect(supportsSubagentFastMode("codex", "newly-advertised-model")).toBe(true);
  });
});
