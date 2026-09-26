import {
  serializeMessage,
  type JSONRPCErrorResponse,
  type RequestId,
} from "@modelcontextprotocol/client";
import * as Schema from "effect/Schema";

/** The JSON-RPC request members that fixtures route on. */
const wireSchema = Schema.Struct({
  _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  method: Schema.String,
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});
export type FixtureRequest = typeof wireSchema.Type;
const wireJson = Schema.fromJsonString(wireSchema);
export const parseWire = Schema.decodeUnknownSync(wireJson);
export const parseWireOption = Schema.decodeUnknownOption(wireJson);

/** A legacy `initialize` result. */
export const legacyInitialized = (capabilities: Schema.JsonObject = {}) => ({
  protocolVersion: "2025-11-25",
  capabilities,
  serverInfo: { name: "fixture", version: "1" },
});

const json = { "content-type": "application/json" };
export const rpcResult = (id: RequestId, result: Schema.JsonObject, headers: HeadersInit = json) =>
  new Response(serializeMessage({ jsonrpc: "2.0", id, result }), { headers });
export const rpcError = (id: RequestId, error: JSONRPCErrorResponse["error"], status = 200) =>
  new Response(serializeMessage({ jsonrpc: "2.0", id, error }), { status, headers: json });
/** Encodes messages as consecutive server-sent `data:` frames. */
export const sseFrames = (...messages: ReadonlyArray<unknown>) =>
  new TextEncoder().encode(
    messages.map((message) => `data: ${JSON.stringify(message)}\n\n`).join(""),
  );
export const sseResponse = (body: BodyInit) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });
export const streamResponse = (source: UnderlyingDefaultSource<Uint8Array>, init?: ResponseInit) =>
  new Response(new ReadableStream<Uint8Array>(source), init);
