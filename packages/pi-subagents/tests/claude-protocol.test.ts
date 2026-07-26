// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  claudeEnvelopeToAgentEvents,
  decodeClaudeStreamEnvelope,
} from "../src/boundary/claude-protocol.ts";

const decode = (value: unknown) => Effect.runPromise(decodeClaudeStreamEnvelope(value));

describe("Claude stream protocol", () => {
  it("decodes initialization and ignores open-set events", async () => {
    await expect(
      decode({
        type: "system",
        subtype: "init",
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        model: "claude-sonnet-5",
      }),
    ).resolves.toMatchObject({ type: "system", subtype: "init" });
    await expect(decode({ type: "stream_event", event: {} })).resolves.toEqual({
      type: "ignored",
      eventType: "stream_event",
    });
  });

  it("normalizes assistant text and tool lifecycle blocks", async () => {
    const tools = new Map<string, string>();
    const assistant = await decode({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Inspecting auth." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/auth.ts" } },
        ],
      },
    });
    const started = claudeEnvelopeToAgentEvents(assistant, { tools });
    expect(started).toEqual([
      { type: "assistant", text: "Inspecting auth." },
      {
        type: "tool_started",
        toolCallId: "tool-1",
        toolName: "Read",
        args: { file_path: "src/auth.ts" },
      },
    ]);

    tools.set("tool-1", "Read");
    const user = await decode({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "source" }],
      },
    });
    expect(claudeEnvelopeToAgentEvents(user, { tools })).toEqual([
      { type: "tool_finished", toolCallId: "tool-1", toolName: "Read", isError: false },
    ]);

    const stringUser = await decode({
      type: "user",
      message: { content: "Continue the review." },
    });
    expect(claudeEnvelopeToAgentEvents(stringUser, { tools })).toEqual([]);
  });

  it("normalizes rate-limit status without confusing rejected overage with rejection", async () => {
    const allowed = await decode({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1_700_003_600,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
      },
    });
    expect(claudeEnvelopeToAgentEvents(allowed, { tools: new Map() })).toEqual([
      {
        type: "rate_limit",
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1_700_003_600,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
      },
    ]);

    const rejected = await decode({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        rateLimitType: "seven_day_opus",
        utilization: 1,
        resetsAt: 1_700_003_600,
      },
    });
    expect(claudeEnvelopeToAgentEvents(rejected, { tools: new Map() })).toEqual([
      {
        type: "rate_limit",
        status: "rejected",
        rateLimitType: "seven_day_opus",
        utilization: 1,
        resetsAt: 1_700_003_600,
      },
    ]);

    const futureStatus = await decode({
      type: "rate_limit_event",
      rate_limit_info: { status: "future_status" },
    });
    expect(claudeEnvelopeToAgentEvents(futureStatus, { tools: new Map() })).toEqual([]);
  });

  it("normalizes terminal result usage and failures", async () => {
    const success = await decode({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Review complete.",
      total_cost_usd: 0.12,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 2,
      },
    });
    expect(claudeEnvelopeToAgentEvents(success, { tools: new Map() })).toEqual([
      {
        type: "settled",
        finalText: "Review complete.",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 20,
          cacheWrite: 2,
          totalTokens: 37,
          cost: 0.12,
        },
      },
    ]);

    const failure = await decode({
      type: "result",
      subtype: "error",
      is_error: true,
      errors: ["Authentication failed."],
      total_cost_usd: 0.03,
      usage: { input_tokens: 4, output_tokens: 2 },
    });
    expect(claudeEnvelopeToAgentEvents(failure, { tools: new Map() })).toEqual([
      {
        type: "failed",
        message: "Authentication failed.",
        usage: {
          input: 4,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 6,
          cost: 0.03,
        },
      },
    ]);

    const maxTurns = await decode({
      type: "result",
      subtype: "error_max_turns",
      is_error: false,
    });
    expect(claudeEnvelopeToAgentEvents(maxTurns, { tools: new Map() })).toEqual([
      {
        type: "failed",
        message: "Claude Code ended with error_max_turns.",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0,
        },
      },
    ]);

    const emptyApiError = await decode({
      type: "result",
      subtype: "success",
      is_error: true,
    });
    expect(claudeEnvelopeToAgentEvents(emptyApiError, { tools: new Map() })).toEqual([
      {
        type: "failed",
        message: "Claude Code ended with an error.",
        fallbackMessage: true,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0,
        },
      },
    ]);
  });

  it("rejects malformed known events", async () => {
    await expect(decode({ type: "assistant", message: {} })).rejects.toBeDefined();
    await expect(
      decode({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
      }),
    ).rejects.toBeDefined();
    const oversized = await decode({
      type: "result",
      result: "x".repeat(1024 * 1024 + 1),
      usage: { input_tokens: "unknown" },
      total_cost_usd: "unknown",
      errors: [{ message: "future structured error" }],
    });
    expect(claudeEnvelopeToAgentEvents(oversized, { tools: new Map() })).toMatchObject([
      {
        type: "settled",
        usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
      },
    ]);

    const invalidNumbers = await decode({
      type: "result",
      subtype: "success",
      result: "done",
      usage: { input_tokens: -1, output_tokens: 1.5 },
      total_cost_usd: Number.POSITIVE_INFINITY,
    });
    expect(claudeEnvelopeToAgentEvents(invalidNumbers, { tools: new Map() })).toMatchObject([
      {
        type: "settled",
        usage: { input: 0, output: 0, totalTokens: 0, cost: 0 },
      },
    ]);
  });
});
