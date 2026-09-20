import { type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { projectOpenAIResponseInput } from "../src/compaction/projection.ts";

const model: Model<"openai-responses"> = {
  id: "target-model",
  name: "target-model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.invalid",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
});

describe("OpenAI compaction transcript projection", () => {
  it("accepts ordinary assistant text without an optional phase", () => {
    const manager = SessionManager.inMemory("/virtual/projection");
    manager.appendMessage({ role: "user", content: "question", timestamp: 0 });
    manager.appendMessage(assistant([{ type: "text", text: "ordinary answer" }]));
    const input = projectOpenAIResponseInput(model, manager.buildContextEntries());
    expect(input).toHaveLength(2);
    expect(JSON.stringify(input)).toContain("ordinary answer");
    expect(input?.[1]).not.toHaveProperty("phase");
  });

  for (const supportsMidConvoSystemMessages of [false, true]) {
    it(`preserves native grammar tool input, mid-conversation=${supportsMidConvoSystemMessages}`, () => {
      const manager = SessionManager.inMemory("/virtual/grammar-projection");
      manager.appendMessage({
        role: "system",
        content: "rules",
        timestamp: 0,
        toolsAdded: [
          {
            name: "grammar",
            description: "grammar tool",
            parameters: {
              type: "object",
              properties: { source: { type: "string" } },
              required: ["source"],
            },
            constrainedSampling: { type: "grammar", variants: { openai_regex: ".*" } },
          },
        ],
      });
      manager.appendMessage(
        assistant([
          {
            type: "toolCall",
            id: "grammar-call",
            name: "grammar",
            arguments: { source: "native grammar input" },
          },
        ]),
      );
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "grammar-call",
        toolName: "grammar",
        content: [{ type: "text", text: "grammar result" }],
        isError: false,
        timestamp: 2,
      });
      const input = projectOpenAIResponseInput(
        { ...model, compat: { supportsMidConvoSystemMessages, supportsOpenAIGrammarTools: true } },
        manager.buildContextEntries(),
      );
      expect(input).toHaveLength(2);
      expect(input?.[0]?.input).toBe("native grammar input");
      expect(input?.[0]).not.toHaveProperty("arguments");
      expect(input?.[1]?.output).toContain("grammar result");
    });
  }

  for (const crossModel of [false, true]) {
    for (const id of ["bare-call", "call|fc_item"]) {
      it(`preserves tool calls and results with ${id}, cross-model=${crossModel}`, () => {
        const manager = SessionManager.inMemory("/virtual/projection");
        const message = assistant([
          { type: "toolCall", id, name: "read", arguments: { path: "file" } },
        ]);
        manager.appendMessage({ ...message, model: crossModel ? "other-model" : model.id });
        manager.appendMessage({
          role: "toolResult",
          toolCallId: id,
          toolName: "read",
          content: [{ type: "text", text: "tool answer" }],
          isError: false,
          timestamp: 2,
        });
        const input = projectOpenAIResponseInput(model, manager.buildContextEntries());
        expect(input).toHaveLength(2);
        expect(JSON.stringify(input)).toContain("tool answer");
        expect(input?.[0]?.call_id).toBe(input?.[1]?.call_id);
        expect(input?.[0]?.arguments).toContain("file");
      });
    }
  }
});
