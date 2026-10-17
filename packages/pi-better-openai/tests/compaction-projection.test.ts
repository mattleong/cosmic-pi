import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import { projectOpenAIResponseInput } from "../src/compaction/projection.ts";
import { assistantMessage, testModel } from "./helpers.ts";

const model = testModel();

describe("OpenAI compaction transcript projection", () => {
  for (const supportsMidConvoSystemMessages of [true]) {
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
        assistantMessage([
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

  for (const crossModel of [true]) {
    for (const id of ["call|fc_item"]) {
      it(`preserves tool calls and results with ${id}, cross-model=${crossModel}`, () => {
        const manager = SessionManager.inMemory("/virtual/projection");
        const message = assistantMessage([
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
