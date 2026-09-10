import type { ExtensionContext, Theme, ToolResultEvent } from "@earendil-works/pi-coding-agent";
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
import { buildMcpTool } from "../src/tools/controller.ts";
import type { McpGatewayReply } from "../src/tools/model.ts";

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

describe("owned MCP error delivery", () => {
  it.effect(
    "rendering preserves the machine envelope, native images and receipt identity without another execution",
    () =>
      Effect.gen(function* () {
        const receipts = makeMcpErrorReceipts();
        const owner = Symbol();
        receipts.activate(owner);
        const image = {
          type: "image" as const,
          mimeType: "image/png",
          data: "existing-image-bytes",
        };
        let executions = 0;
        const tool = buildMcpTool({
          owner,
          receipts,
          execute: () => {
            executions++;
            return Promise.resolve({ reply: failure, images: [image] });
          },
        });
        const result = yield* Effect.tryPromise(() =>
          tool.execute(
            "call",
            { action: "tools.call", server: "docs", tool: "lookup" },
            undefined,
            undefined,
            unusedContext,
          ),
        );
        const serialized = serialize(result);
        // SAFETY: Only these two semantic theme methods are consumed by this card fixture.
        const theme = {
          fg: (_color: string, text: string) => text,
          bold: (text: string) => text,
        } as Theme;
        const context = {
          args: {},
          toolCallId: "call",
          invalidate: () => undefined,
          lastComponent: undefined,
          state: {},
          cwd: "/project",
          executionStarted: true,
          argsComplete: true,
          isPartial: false,
          expanded: false,
          showImages: true,
          isError: true,
        };
        for (const expanded of [false, true, false]) {
          tool.renderCall!({}, theme, context).render(60);
          tool.renderResult!(result, { expanded, isPartial: false }, theme, context).render(60);
        }
        expect(executions).toBe(1);
        expect(serialize(result)).toBe(serialized);
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
        const receipts = makeMcpErrorReceipts();
        const owner = Symbol();
        receipts.activate(owner);
        const tool = buildMcpTool({
          owner,
          receipts,
          execute: () => Promise.resolve({ reply, images: [] }),
        });
        const result = yield* Effect.tryPromise(() =>
          tool.execute("call", {}, undefined, undefined, unusedContext),
        );
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
      const receipts = makeMcpErrorReceipts();
      const owner = Symbol();
      receipts.activate(owner);
      const tool = buildMcpTool({
        owner,
        receipts,
        execute: () => Promise.resolve({ reply: large, images: [] }),
      });
      const result = yield* Effect.tryPromise(() =>
        tool.execute("large", {}, undefined, undefined, unusedContext),
      );
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
