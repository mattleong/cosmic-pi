let input = Buffer.alloc(0);
const waiting = new Map();
let cancelled = 0;

const writeMessage = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sendResult = (id, result) => writeMessage({ jsonrpc: "2.0", id, result });
const sendError = (id, code, message) =>
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (text) => ({ content: [{ type: "text", text }], isError: text === "error" });

const respond = (message) => {
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    if (process.argv[2] === "hang-init") return;
    if (process.argv[2] === "fail-init") {
      sendError(message.id, -32603, "private-fixture-initialization-error");
      return;
    }
    sendResult(message.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "stdio-fixture", version: "1.0.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    const result = {
      tools: [
        {
          name: "echo",
          description: "Echo fixture input",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    };
    if (message.params?.cursor === "") result.nextCursor = "empty-cursor-preserved";
    sendResult(message.id, result);
    return;
  }
  if (message.method === "tools/call") {
    let text = String(message.params?.arguments?.text ?? "");
    if (text === "wait" || text === "wait-peer") {
      waiting.set(message.id, text);
      return;
    }
    if (text === "release") {
      for (const [id, value] of waiting) sendResult(id, toolResult(value));
      waiting.clear();
    }
    if (text === "stats") text = `waiting=${waiting.size},cancelled=${cancelled}`;
    if (text === "oversized") text = "private-output".repeat(1024);
    if (text === "malformed") {
      process.stdout.write('{"private-malformed-output":true}\n');
      return;
    }
    sendResult(message.id, toolResult(text));
    return;
  }
  if (message.method === "resources/list") {
    sendResult(message.id, { resources: [] });
    return;
  }
  if (message.method === "resources/templates/list") {
    sendResult(message.id, { resourceTemplates: [] });
    return;
  }
  if (message.method === "prompts/list") {
    sendResult(message.id, { prompts: [] });
    return;
  }
  if (message.method === "resources/read") {
    sendResult(message.id, { contents: [{ uri: message.params?.uri, text: "fixture" }] });
    return;
  }
  if (message.method === "prompts/get") {
    sendResult(message.id, { description: "fixture", messages: [] });
    return;
  }
  if (message.method === "notifications/cancelled") {
    if (waiting.delete(message.params?.requestId)) cancelled++;
    return;
  }
  sendError(message.id, -32601, "method not found");
};

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const separator = input.indexOf("\n");
    if (separator < 0) return;
    const body = input.subarray(0, separator).toString("utf8");
    input = input.subarray(separator + 1);
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      process.exit(3);
    }
    respond(message);
  }
});
process.stdin.on("end", () => process.exit(0));
