// Local-only MCP fixture for the packed-consumer smoke. No credentials, network, or SDK dependency.
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

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
input.on("close", finish);
process.on("SIGTERM", finish);
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "cosmic-pack-fixture", version: "1.0.0" },
        instructions: "Local packed-source echo fixture",
      };
      break;
    case "ping":
      result = {};
      break;
    case "tools/list":
      result = {
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
      break;
    case "tools/call":
      result = {
        content: [
          { type: "text", text: request.params.arguments.text },
          { type: "image", mimeType: "image/png", data: png },
        ],
        structuredContent: { echoed: request.params.arguments.text },
        isError: false,
      };
      break;
    case "resources/list":
      result = {
        resources: [{ uri: "fixture://packed", name: "Packed source", mimeType: "text/plain" }],
      };
      break;
    case "resources/templates/list":
      result = { resourceTemplates: [] };
      break;
    case "resources/read":
      result = {
        contents: [{ uri: request.params.uri, mimeType: "text/plain", text: "packed resource" }],
      };
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
      );
      return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
