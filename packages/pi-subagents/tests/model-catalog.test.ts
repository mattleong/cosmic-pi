import { describe, expect, it } from "vitest";
import {
  CLAUDE_CLI_ALIAS_MODELS,
  claudeCliModelConflict,
  launchReadyModelLine,
  resolvePiModelSelector,
  searchSubagentModels,
} from "../src/run/model-catalog.ts";
import type { SubagentModelView } from "../src/run/model.ts";

const piView = (provider: string, id: string, name: string): SubagentModelView => ({
  backend: "pi",
  id: `${provider}/${id}`,
  name,
  reasoning: true,
});

const catalog: ReadonlyArray<SubagentModelView> = [
  piView("openai-codex", "gpt-5.5", "GPT 5.5"),
  piView("xai", "grok-5-fast", "Grok 5 Fast"),
  piView("anthropic", "claude-opus-5", "Claude Opus 5"),
  piView("anthropic", "claude-sonnet-5", "Claude Sonnet 5"),
  ...CLAUDE_CLI_ALIAS_MODELS,
];

describe("model catalog", () => {
  it("prints launch-ready backend and model values", () => {
    expect(launchReadyModelLine(piView("openai-codex", "gpt-5.5", "GPT 5.5"))).toBe(
      "backend=pi model=openai-codex/gpt-5.5 · GPT 5.5 · reasoning",
    );
    expect(launchReadyModelLine(CLAUDE_CLI_ALIAS_MODELS[0]!)).toBe(
      "backend=claude-cli model=fable · Claude Fable (CLI alias) · reasoning",
    );
  });

  it("requires every search term to match and ranks closer matches first", () => {
    expect(searchSubagentModels(catalog, "opus 5").map((model) => model.id)).toEqual([
      "anthropic/claude-opus-5",
    ]);
    expect(searchSubagentModels(catalog, "5").map((model) => model.id)).toEqual([
      "openai-codex/gpt-5.5",
      "xai/grok-5-fast",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
    ]);
    // Exact alias match outranks substring matches deterministically.
    expect(searchSubagentModels(catalog, "opus")[0]?.id).toBe("opus");
    expect(
      searchSubagentModels(catalog, "claude", "claude-cli").map((model) => model.backend),
    ).toEqual(["claude-cli", "claude-cli", "claude-cli", "claude-cli"]);
    expect(searchSubagentModels(catalog, "no-such-model")).toEqual([]);
  });

  it("resolves Pi selectors deterministically without picking among providers", () => {
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

  it("detects Pi selectors sent to claude-cli and leaves Claude selectors alone", () => {
    const available = [
      { provider: "openai-codex", id: "gpt-5.6-sol" },
      { provider: "anthropic", id: "claude-opus-5" },
    ];
    expect(claudeCliModelConflict("openai-codex/gpt-5.6-sol", available)).toMatchObject({
      code: "backend_model_mismatch",
    });
    expect(claudeCliModelConflict("gpt-5.6-sol", available)).toMatchObject({
      code: "backend_model_mismatch",
      message: expect.stringContaining("openai-codex/gpt-5.6-sol"),
    });
    expect(claudeCliModelConflict("unknown/model", available)).toMatchObject({
      code: "claude_model_invalid",
    });
    expect(claudeCliModelConflict("opus", available)).toBeUndefined();
    // A claude-prefixed ID stays valid for claude-cli even when a Pi provider also serves it.
    expect(claudeCliModelConflict("claude-opus-5", available)).toBeUndefined();
    expect(claudeCliModelConflict("claude-opus-5-20260115", available)).toBeUndefined();
  });
});
