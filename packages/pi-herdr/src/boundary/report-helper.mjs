#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const MAX_REPORT_BYTES = 48_000;
const MAX_RPC_LINE_BYTES = 512 * 1024;
const runId = process.env.HERDR_RUN_ID;
const reportDirectory = process.env.HERDR_REPORT_DIR;

if (!runId || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(runId) || !reportDirectory) process.exit(2);

const directory = resolve(reportDirectory);
const reportPath = join(directory, "report.json");
const serverInfo = { name: "pi-herdr-report", version: "1.0.0" };

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const error = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const toolResult = (id, text, isError = false) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  });

const durableWrite = async (document) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.report.${process.pid}.${randomUUID()}.tmp`);
  const source = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(temporaryPath, source, { encoding: "utf8", mode: 0o600 });
  const handle = await open(temporaryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, reportPath);
  const directoryHandle = await open(dirname(reportPath), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  await rm(temporaryPath, { force: true }).catch(() => {});
};

const existingReport = async () => {
  try {
    return JSON.parse(await readFile(reportPath, "utf8"));
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
};

const submit = async (id, args) => {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    toolResult(id, "Report input must be an object.", true);
    return;
  }
  const keys = Object.keys(args);
  if (keys.some((key) => key !== "status" && key !== "report")) {
    toolResult(id, "Report input contains unsupported fields.", true);
    return;
  }
  const { status, report } = args;
  if (
    !["completed", "blocked", "failed"].includes(status) ||
    typeof report !== "string" ||
    !report.trim()
  ) {
    toolResult(id, "Report status and non-empty report text are required.", true);
    return;
  }
  if (Buffer.byteLength(report, "utf8") > MAX_REPORT_BYTES) {
    toolResult(id, `Report exceeds the ${MAX_REPORT_BYTES}-byte limit.`, true);
    return;
  }
  const digest = createHash("sha256").update(`${status}\0${report}`).digest("hex");
  const current = await existingReport();
  if (current) {
    if (current.sha256 === digest) {
      toolResult(id, `Report already accepted; receipt ${current.receiptId}.`);
      return;
    }
    toolResult(id, "A different final report was already accepted for this run.", true);
    return;
  }
  const document = {
    schemaVersion: 1,
    runId,
    receiptId: randomUUID(),
    submittedAt: Date.now(),
    status,
    report,
    sha256: digest,
  };
  await durableWrite(document);
  toolResult(id, `Report durably accepted; receipt ${document.receiptId}.`);
};

const handle = async (message) => {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined;
  switch (message.method) {
    case "initialize": {
      if (id === undefined) return;
      const requested = message.params?.protocolVersion;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo,
        },
      });
      return;
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      if (id === undefined) return;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "submit_report",
              description:
                "Durably submit the complete final report for this delegated task. Call exactly once when completed, blocked, or failed.",
              inputSchema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["completed", "blocked", "failed"] },
                  report: { type: "string", minLength: 1, maxLength: MAX_REPORT_BYTES },
                },
                required: ["status", "report"],
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            },
          ],
        },
      });
      return;
    case "tools/call":
      if (id === undefined) return;
      if (message.params?.name !== "submit_report") {
        toolResult(id, "Unknown tool.", true);
        return;
      }
      await submit(id, message.params?.arguments);
      return;
    default:
      if (id !== undefined) error(id, -32601, "Method not found.");
  }
};

const processLine = async (line) => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) {
    error(null, -32600, "JSON-RPC request exceeds the bounded input limit.");
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    error(null, -32700, "Parse error.");
    return;
  }
  const id =
    message && typeof message === "object" && Object.prototype.hasOwnProperty.call(message, "id")
      ? message.id
      : null;
  try {
    await handle(message);
  } catch {
    error(id, -32603, "Internal report server error.");
  }
};

process.stdin.setEncoding("utf8");
let pending = "";
for await (const chunk of process.stdin) {
  pending += chunk;
  let newline = pending.indexOf("\n");
  while (newline >= 0) {
    const line = pending.slice(0, newline).replace(/\r$/, "");
    pending = pending.slice(newline + 1);
    await processLine(line);
    newline = pending.indexOf("\n");
  }
  if (Buffer.byteLength(pending, "utf8") > MAX_RPC_LINE_BYTES) {
    error(null, -32600, "JSON-RPC request exceeds the bounded input limit.");
    process.stdin.destroy();
    pending = "";
    break;
  }
}
if (pending) await processLine(pending.replace(/\r$/, ""));
