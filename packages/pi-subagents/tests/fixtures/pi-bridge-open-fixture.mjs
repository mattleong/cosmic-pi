#!/usr/bin/env node
import { closeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import readline from "node:readline";

const configIndex = process.argv.indexOf("--config");
const scenarioPath = process.argv[configIndex + 1];
const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
await writeFile(`${scenarioPath}.pid`, String(process.pid));

if (scenario.mode === "malformed") {
  process.stdout.write("{not-json}\n");
  setInterval(() => {}, 1_000);
} else if (scenario.mode === "timeout") {
  setInterval(() => {}, 1_000);
} else {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.method !== "initialize") return;
    if (scenario.mode === "notification-close") closeSync(0);
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fixture", version: "1" },
        },
      })}\n`,
      scenario.mode === "notification-close" ? () => process.exit(0) : undefined,
    );
  });
  setInterval(() => {}, 1_000);
}
