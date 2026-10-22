import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { decodeMcpMessage, validRpcId } from "../src/supervisor/mcp-wire.ts";

const request = (method: string, fields: Record<string, Schema.Json> = {}): Schema.Json => ({
  jsonrpc: "2.0",
  method,
  ...fields,
});
const nested = (depth: number): Schema.Json => (depth === 0 ? 1 : { a: nested(depth - 1) });
const toolCall = (params: Record<string, Schema.Json>) =>
  request("tools/call", { id: 1, params: { name: "agent_list", arguments: {}, ...params } });

describe("MCP message decoding", () => {
  it("accepts each served method in its exact shape", () => {
    expect(
      decodeMcpMessage(
        request("initialize", {
          id: 1,
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c" } },
        }),
      ),
    ).toEqual({ method: "initialize", id: 1, protocolVersion: "2025-06-18" });
    expect(decodeMcpMessage(request("notifications/initialized"))).toEqual({
      method: "notifications/initialized",
    });
    expect(
      decodeMcpMessage(
        request("notifications/cancelled", { params: { requestId: "r-1", reason: "" } }),
      ),
    ).toEqual({ method: "notifications/cancelled", requestId: "r-1" });
    expect(decodeMcpMessage(request("ping", { id: "a", params: { _meta: {} } }))).toEqual({
      method: "ping",
      id: "a",
    });
    expect(decodeMcpMessage(request("tools/list", { id: 2 }))).toEqual({
      method: "tools/list",
      id: 2,
    });
    expect(decodeMcpMessage(toolCall({ arguments: null }))).toEqual({
      method: "tools/call",
      id: 1,
      name: "agent_list",
      arguments: null,
    });
  });

  it("answers an unserved method by its id instead of rejecting it", () => {
    expect(
      decodeMcpMessage(request("resources/list", { id: 3, params: { any: [1, { a: 2 }] } })),
    ).toEqual({ method: "unknown", id: 3 });
    expect(decodeMcpMessage(request("notifications/other"))).toEqual({ method: "unknown" });
  });

  it.each<[string, Schema.Json]>([
    ["a non-object", [request("ping", { id: 1 })]],
    ["another JSON-RPC version", { jsonrpc: "1.0", method: "ping", id: 1 }],
    ["a missing method", { jsonrpc: "2.0", id: 1 }],
    ["an empty method", request("", { id: 1 })],
    ["an overlong method", request("m".repeat(129), { id: 1 })],
    ["an extra envelope field", request("ping", { id: 1, extra: true })],
    ["a fractional id", request("ping", { id: 1.5 })],
    ["a null id", request("ping", { id: null })],
    ["an empty id", request("ping", { id: "" })],
    ["an overlong id", request("ping", { id: "i".repeat(257) })],
    ["an unserved method with an invalid id", request("resources/list", { id: 1.5 })],
    ["a request without an id", request("ping")],
    ["a notification with an id", request("notifications/initialized", { id: 1 })],
    ["non-object params", request("ping", { id: 1, params: [] })],
    ["unknown params", request("ping", { id: 1, params: { other: 1 } })],
    ["initialize without a protocol version", request("initialize", { id: 1, params: {} })],
    [
      "a blank protocol version",
      request("initialize", { id: 1, params: { protocolVersion: " " } }),
    ],
    [
      "an overlong protocol version",
      request("initialize", { id: 1, params: { protocolVersion: "v".repeat(65) } }),
    ],
    ["a cancellation without its request", request("notifications/cancelled", { params: {} })],
    [
      "an overlong cancellation reason",
      request("notifications/cancelled", { params: { requestId: 1, reason: "r".repeat(513) } }),
    ],
    [
      "a tool call without arguments",
      request("tools/call", { id: 1, params: { name: "agent_list" } }),
    ],
    ["a blank tool name", toolCall({ name: " " })],
    ["an overlong tool name", toolCall({ name: "t".repeat(129) })],
    ["an extra tool-call field", toolCall({ extra: 1 })],
    ["metadata nested too deep", toolCall({ _meta: nested(7) })],
    ["an overlong metadata string", toolCall({ _meta: "m".repeat(4097) })],
    ["metadata with too many entries", toolCall({ _meta: Array.from({ length: 65 }, () => 1) })],
    ["an overlong metadata key", toolCall({ _meta: { ["k".repeat(129)]: 1 } })],
  ])("rejects %s", (_case, value) => {
    expect(decodeMcpMessage(value)).toBeUndefined();
  });

  it("names the native calling thread only when its metadata names one within bounds", () => {
    expect(decodeMcpMessage(toolCall({ _meta: { threadId: "thread-1" } }))).toMatchObject({
      nativeThreadId: "thread-1",
    });
    for (const threadId of [" ", "t".repeat(257), 3])
      expect(decodeMcpMessage(toolCall({ _meta: { threadId } }))).not.toHaveProperty(
        "nativeThreadId",
      );
    expect(decodeMcpMessage(toolCall({ _meta: nested(6) }))).toMatchObject({
      method: "tools/call",
    });
  });

  it("accepts only bounded string and safe integer request ids", () => {
    expect([1, -3, "a", "i".repeat(256)].every(validRpcId)).toBe(true);
    expect([1.5, 2 ** 60, "", "i".repeat(257), null, true].some(validRpcId)).toBe(false);
  });
});
