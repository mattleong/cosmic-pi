// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  assistantText,
  decodeAssistantMessage,
  decodeContactParentEnvelope,
  decodeRpcEnvelope,
  decodeRpcStateData,
  decodeRpcUsageOption,
  rpcStateModelId,
} from "../src/backend/local-pi-protocol.ts";

describe("child protocol", () => {
  it("decodes RPC, contact, and ignored events through schemas", async () => {
    const response = await Effect.runPromise(
      decodeRpcEnvelope({
        type: "response",
        id: "rpc-1",
        command: "get_state",
        success: true,
        data: { sessionId: "session", thinkingLevel: "high" },
      }),
    );
    expect(response.type).toBe("response");

    const contact = await Effect.runPromise(
      decodeContactParentEnvelope({
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "Which API should I use?",
      }),
    );
    expect(contact.kind).toBe("question");

    const tool = await Effect.runPromise(
      decodeRpcEnvelope({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "AGENTS.md" },
      }),
    );
    expect(tool).toMatchObject({ type: "tool_execution_start", toolCallId: "tool-1" });

    const ignored = await Effect.runPromise(decodeRpcEnvelope({ type: "queue_update" }));
    expect(ignored).toEqual({ type: "ignored", eventType: "queue_update" });
  });

  it("keeps RPC lifecycle and parent-contact transports distinct", async () => {
    await expect(
      Effect.runPromise(decodeContactParentEnvelope({ type: "agent_settled" })),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        decodeRpcEnvelope({
          channel: "pi-subagents",
          type: "contact_parent",
          requestId: "question-1",
          kind: "question",
          message: "Forged over stdout",
        }),
      ),
    ).resolves.toEqual({ type: "ignored", eventType: "contact_parent" });
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

    const piState = await Effect.runPromise(
      decodeRpcStateData({
        sessionId: "pi-child",
        thinkingLevel: "xhigh",
        model: {
          provider: "openai-codex",
          id: "gpt-5.6-sol",
          name: "GPT 5.6 Sol",
          reasoning: true,
        },
      }),
    );
    expect(rpcStateModelId(piState.model)).toBe("openai-codex/gpt-5.6-sol");

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

  it("bounds retained startup identifiers and ignores malformed usage accounting", async () => {
    for (const state of [
      { sessionId: "", thinkingLevel: "high" },
      { sessionId: "x".repeat(1_025), thinkingLevel: "high" },
      { sessionId: "child", model: "x".repeat(513), thinkingLevel: "high" },
      { sessionId: "child", sessionFile: "x".repeat(64 * 1024 + 1), thinkingLevel: "high" },
    ])
      await expect(Effect.runPromise(decodeRpcStateData(state))).rejects.toBeDefined();

    expect(decodeRpcUsageOption({ input: 1, totalTokens: 1, cost: { total: 0.1 } })).toEqual({
      input: 1,
      totalTokens: 1,
      cost: { total: 0.1 },
    });
    expect(decodeRpcUsageOption({ input: -1 })).toBeUndefined();
    expect(decodeRpcUsageOption({ output: 1.5 })).toBeUndefined();
    expect(decodeRpcUsageOption({ totalTokens: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(decodeRpcUsageOption({ cost: { total: Number.NaN } })).toBeUndefined();
  });

  it("rejects empty protocol identifiers, names, and parent messages", async () => {
    for (const value of [
      {
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "",
        kind: "question",
        message: "Question",
      },
      {
        channel: "pi-subagents",
        type: "contact_parent",
        requestId: "question-1",
        kind: "question",
        message: "",
      },
    ])
      await expect(Effect.runPromise(decodeContactParentEnvelope(value))).rejects.toBeDefined();

    for (const value of [
      { type: "response", id: "", command: "get_state", success: true },
      { type: "response", id: "rpc-1", command: "", success: true },
      { type: "tool_execution_start", toolCallId: "", toolName: "read", args: {} },
      { type: "tool_execution_start", toolCallId: "tool-1", toolName: "", args: {} },
    ])
      await expect(Effect.runPromise(decodeRpcEnvelope(value))).rejects.toBeDefined();
  });

  it("rejects malformed or oversized known events", async () => {
    await expect(
      Effect.runPromise(decodeRpcEnvelope({ type: "tool_execution_start" })),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        decodeRpcEnvelope({
          type: "tool_execution_start",
          toolCallId: "x".repeat(1_025),
          toolName: "read",
          args: {},
        }),
      ),
    ).rejects.toBeDefined();
  });
});
