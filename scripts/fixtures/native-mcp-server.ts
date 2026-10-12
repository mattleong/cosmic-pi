import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { Schema } from "effect";

const Request = Schema.Struct({
  id: Schema.optional(Schema.Json),
  method: Schema.optional(Schema.String),
  params: Schema.optional(
    Schema.Struct({
      protocolVersion: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
      uri: Schema.optional(Schema.String),
    }),
  ),
});

type Request = typeof Request.Type;

const requestFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(Request));

const marker = process.argv[2];
if (!marker) throw new Error("Native MCP fixture needs a lifecycle marker path.");
writeFileSync(marker, JSON.stringify({ pid: process.pid, state: "running" }));
const input = createInterface({ input: process.stdin });
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const finish = () => {
  writeFileSync(marker, JSON.stringify({ pid: process.pid, state: "closed" }));
  process.exit(0);
};

function resultFor(request: Request) {
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "cosmic-pack-fixture", version: "1.0.0" },
        instructions: "Local packed-source echo fixture",
      };
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: [
          {
            name: "echo",
            description: "Echo fixture input with a native image and structured evidence",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        ],
      };
    case "tools/call":
      return {
        content: [
          { type: "text", text: request.params?.arguments?.text },
          { type: "image", mimeType: "image/png", data: png },
        ],
        structuredContent: { echoed: request.params?.arguments?.text },
        isError: false,
      };
    case "resources/list":
      return {
        resources: [{ uri: "fixture://packed", name: "Packed source", mimeType: "text/plain" }],
      };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read":
      return {
        contents: [{ uri: request.params?.uri, mimeType: "text/plain", text: "packed resource" }],
      };
    case undefined:
    default:
      return undefined;
  }
}

input.on("close", finish);
process.on("SIGTERM", finish);
input.on("line", (line) => {
  const request = requestFromJson(line);
  if (request.id === undefined) return;
  const result = resultFor(request);
  const response =
    result === undefined
      ? {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        }
      : { jsonrpc: "2.0", id: request.id, result };
  process.stdout.write(`${JSON.stringify(response)}\n`);
});
