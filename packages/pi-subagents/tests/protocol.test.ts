// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  assistantText,
  decodeAssistantMessage,
  decodeChildEnvelope,
  decodeRpcStateData,
} from "../src/run/protocol.ts";

describe("child protocol", () => {
  it("decodes RPC, contact, and ignored events through schemas", async () => {
    const response = await Effect.runPromise(
      decodeChildEnvelope({
        type: "response",
        id: "rpc-1",
        command: "get_state",
        success: true,
        data: { sessionId: "session", thinkingLevel: "high" },
      }),
    );
    expect(response.type).toBe("response");

    const contact = await Effect.runPromise(
      decodeChildEnvelope({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which API should I use?",
      }),
    );
    expect("channel" in contact && contact.kind).toBe("question");

    const tool = await Effect.runPromise(
      decodeChildEnvelope({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "AGENTS.md" },
      }),
    );
    expect(tool).toMatchObject({ type: "tool_execution_start", toolCallId: "tool-1" });

    const ignored = await Effect.runPromise(decodeChildEnvelope({ type: "queue_update" }));
    expect(ignored).toEqual({ type: "ignored", eventType: "queue_update" });
  });

  it("decodes state and extracts assistant text", async () => {
    const state = await Effect.runPromise(
      decodeRpcStateData({
        sessionId: "child",
        sessionFile: "/tmp/child.jsonl",
        thinkingLevel: "high",
      }),
    );
    expect(state.sessionFile).toBe("/tmp/child.jsonl");

    const message = await Effect.runPromise(
      decodeAssistantMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Finished work." },
        ],
        usage: { totalTokens: 42, cost: { total: 0.01 } },
      }),
    );
    expect(message && assistantText(message)).toBe("Finished work.");
  });

  it("rejects malformed known events", async () => {
    await expect(
      Effect.runPromise(decodeChildEnvelope({ type: "tool_execution_start" })),
    ).rejects.toBeDefined();
  });
});
