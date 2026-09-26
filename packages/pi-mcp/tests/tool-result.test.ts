import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
const serialize = <Value>(value: Value) => JSON.stringify(value);
// SAFETY: The tool controller never reads the Pi context; its execution port owns context checks.
const unusedContext = {} as ExtensionContext;
import {
  boundedMcpReply,
  makeMcpErrorReceipts,
  mcpFailureReply,
} from "../src/boundary/host-tool-result.ts";
import { boundaryError } from "../src/client/errors.ts";
import { buildMcpTool, type McpToolDefinition } from "../src/tools/controller.ts";
import type { McpGatewayReply, McpGatewayExecution } from "../src/tools/model.ts";

const failure: McpGatewayReply = {
  action: "tools.call",
  outcome: "completed",
  isError: true,
  data: {
    structuredContent: { rejected: true },
    content: [{ type: "text", text: "Tool rejected operation" }],
  },
  resultId: "retained-1",
  notices: [],
};
const event = (details: McpGatewayReply, toolCallId = "call"): ToolResultEvent => ({
  type: "tool_result",
  toolName: "mcp",
  toolCallId,
  input: {},
  content: [{ type: "text", text: "earlier middleware content" }],
  details,
  isError: false,
});

/** Builds an activated owned tool whose execution port returns `execution`. */
const owned = (execution: McpGatewayExecution) => {
  const receipts = makeMcpErrorReceipts();
  const owner = Symbol();
  receipts.activate(owner);
  let executions = 0;
  const tool = buildMcpTool({
    owner,
    receipts,
    execute: () => {
      executions++;
      return Promise.resolve(execution);
    },
  });
  const run = (input: Parameters<McpToolDefinition["execute"]>[1] = {}) =>
    Effect.tryPromise(() => tool.execute("call", input, undefined, undefined, unusedContext));
  return { receipts, tool, run, executions: () => executions };
};

describe("owned MCP error delivery", () => {
  it.effect.each(["completed", "unknown", "not-sent"] as const)(
    "withdraws output cancelled at final host publication without changing %s certainty",
    (outcome) =>
      Effect.gen(function* () {
        const abort = new AbortController();
        const { receipts, tool } = owned({
          reply: { ...failure, outcome, data: { secret: "private-body" } },
          images: [{ type: "image", data: "private-image", mimeType: "image/png" }],
        });
        const result = yield* Effect.tryPromise(() => {
          const pending = tool.execute("call", {}, abort.signal, undefined, unusedContext);
          // Execution is already resolved. Abort before the controller's publication continuation.
          abort.abort();
          return pending;
        });
        expect(result.details).toMatchObject({
          outcome,
          isError: true,
          data: { kind: "cancelled" },
        });
        expect(result.details.resultId).toBeUndefined();
        expect(result.content).toHaveLength(1);
        expect(serialize(result)).not.toMatch(/private-body|private-image|retained-1/);
        expect(receipts.apply(event(result.details))).toEqual({ isError: true });
      }),
  );

  it.effect(
    "shapes the machine envelope, native images and receipt identity from one execution",
    () =>
      Effect.gen(function* () {
        const image = {
          type: "image" as const,
          mimeType: "image/png",
          data: "existing-image-bytes",
        };
        const { receipts, run, executions } = owned({ reply: failure, images: [image] });
        const result = yield* run({ action: "tools.call", server: "docs", tool: "lookup" });
        expect(executions()).toBe(1);
        expect(result.details).toBe(failure);
        expect(result.content[0]).toEqual({ type: "text", text: serialize(failure) });
        expect(result.content[1]).toBe(image);
        expect(receipts.apply(event(result.details))).toEqual({ isError: true });
      }),
  );

  it("projects diagnostic reasons without exposing even typed exception messages", () => {
    for (const reason of [
      undefined,
      "oauth-resource-metadata-missing",
      "oauth-resource-metadata-invalid",
    ] as const) {
      const reply = mcpFailureReply(
        "command",
        boundaryError(
          "unavailable",
          "not-sent",
          "private-token-callback-url-and-response-body",
          reason,
        ),
      );
      expect(reply).toMatchObject({ outcome: "not-sent", isError: true });
      if (reason !== undefined) expect(reply.data).toMatchObject({ reason });
      expect(serialize(reply)).not.toContain("private-token");
    }
  });

  it.effect.each([
    failure,
    mcpFailureReply(
      "tools.search",
      boundaryError("protocol", "completed", "private-token", "rpc-invalid-params"),
    ),
  ])(
    "patches an actual owned execute result once without replacing bounded details or prior content",
    (reply) =>
      Effect.gen(function* () {
        const { receipts, run } = owned({ reply, images: [] });
        const result = yield* run();
        const original = event(result.details);
        const patch = receipts.apply(original);
        expect({ ...original, ...patch }).toMatchObject({
          isError: true,
          details: reply,
          content: original.content,
        });
        expect(result.details).toBe(reply);
        if (reply.resultId === undefined) {
          expect(result.details.resultId).toBeUndefined();
          expect(serialize(result)).not.toMatch(/private-token|existing result|result\.read/);
        }
        expect(patch).toEqual({ isError: true });
        expect(receipts.apply(original)).toBeUndefined();
      }),
  );

  it("does not touch foreign, forged, stale, or successful results", () => {
    const receipts = makeMcpErrorReceipts();
    const first = Symbol();
    receipts.activate(first);
    receipts.retain("call", first, failure);
    expect(receipts.apply({ ...event(failure), toolName: "other" })).toBeUndefined();
    expect(receipts.apply(event({ ...failure }))).toBeUndefined();
    receipts.activate(Symbol());
    expect(receipts.apply(event(failure))).toBeUndefined();
    receipts.retain("call", first, failure);
    expect(receipts.apply(event(failure))).toBeUndefined();
    const owner = Symbol();
    receipts.activate(owner);
    const success = { ...failure, isError: false };
    receipts.retain("call", owner, success);
    expect(receipts.apply(event(success))).toBeUndefined();
  });

  it("bounds unmatched receipts and clears them at lifecycle boundaries", () => {
    const receipts = makeMcpErrorReceipts();
    const owner = Symbol();
    receipts.activate(owner);
    for (let index = 0; index < 257; index++) receipts.retain(String(index), owner, failure);
    expect(receipts.apply(event(failure, "0"))).toBeUndefined();
    expect(receipts.apply(event(failure, "256"))).toEqual({ isError: true });
    receipts.clear();
    expect(receipts.apply(event(failure, "255"))).toBeUndefined();
    receipts.retain("call", owner, failure);
    receipts.deactivate();
    expect(receipts.apply(event(failure))).toBeUndefined();
  });

  it.effect("does not put an oversized server payload into text or details", () =>
    Effect.gen(function* () {
      const large = { ...failure, data: { text: "x".repeat(8 * 1024 * 1024) } };
      const result = yield* owned({ reply: large, images: [] }).run();
      expect(Buffer.byteLength(serialize(result))).toBeLessThan(2_000);
      expect(result.details).toMatchObject({
        outcome: "completed",
        resultId: "retained-1",
        isError: true,
      });
      expect(boundedMcpReply(large).data).toMatchObject({ kind: "output-limit" });
    }),
  );
});
