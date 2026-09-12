import { createInterface } from "node:readline";
const mode = process.env.FIXTURE_MODE ?? "modern";
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code) =>
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, error: { code, message: "fixture rejection" } }) + "\n",
  );
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") {
    if (mode === "exit-before-init") {
      process.exit(1);
      return;
    }
    if (mode === "silent" || mode === "silent-all") return;
    if (mode === "legacy") {
      fail(request.id, -32601);
      return;
    }
    send(
      request.id,
      mode === "malformed"
        ? { supportedVersions: 3 }
        : {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
            instructions: String(process.pid),
          },
    );
  } else if (request.method === "initialize") {
    if (mode === "silent-all") return;
    if (mode === "modern") {
      fail(request.id, -32601);
      return;
    }
    send(request.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1" },
    });
  } else if (request.method === "tools/call") {
    send(request.id, {
      resultType: "complete",
      content: [{ type: "text", text: String(process.pid) }],
    });
  } else if (request.id !== undefined) fail(request.id, -32601);
});
