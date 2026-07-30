// Node/Pi Promise behavior is characterized at this test boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const request = (child: ReturnType<typeof spawn>, value: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      child.stdout?.off("data", onData);
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as unknown);
      } catch (error) {
        reject(error);
      }
    };
    child.stdout?.on("data", onData);
    child.stdin?.write(`${JSON.stringify(value)}\n`);
  });

describe("report helper", () => {
  it("durably accepts one idempotent bounded report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-report-"));
    temporaryDirectories.push(directory);
    const helper = fileURLToPath(new URL("../src/boundary/report-helper.mjs", import.meta.url));
    const child = spawn(process.execPath, [helper], {
      env: { ...process.env, HERDR_RUN_ID: "herdr-test", HERDR_REPORT_DIR: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const initialized = await request(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      });
      expect(initialized).toMatchObject({ id: 1, result: { protocolVersion: "2025-06-18" } });
      const listed = await request(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(listed).toMatchObject({ result: { tools: [{ name: "submit_report" }] } });
      const first = await request(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "submit_report",
          arguments: { status: "completed", report: "spike-ok" },
        },
      });
      expect(first).not.toMatchObject({ result: { isError: true } });
      const document = JSON.parse(await readFile(join(directory, "report.json"), "utf8"));
      expect(document).toMatchObject({
        schemaVersion: 1,
        runId: "herdr-test",
        status: "completed",
        report: "spike-ok",
      });
      const retry = await request(child, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "submit_report",
          arguments: { status: "completed", report: "spike-ok" },
        },
      });
      expect(retry).not.toMatchObject({ result: { isError: true } });
      const conflicting = await request(child, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "submit_report",
          arguments: { status: "failed", report: "different" },
        },
      });
      expect(conflicting).toMatchObject({ result: { isError: true } });
      const oversized = await request(child, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "submit_report",
          arguments: { status: "completed", report: "x".repeat(48_001) },
        },
      });
      expect(oversized).toMatchObject({ id: 6, result: { isError: true } });
    } finally {
      child.kill();
    }
  });

  it("preserves the request id when durable report state is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-herdr-report-corrupt-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "report.json"), "not-json", "utf8");
    const helper = fileURLToPath(new URL("../src/boundary/report-helper.mjs", import.meta.url));
    const child = spawn(process.execPath, [helper], {
      env: { ...process.env, HERDR_RUN_ID: "herdr-test", HERDR_REPORT_DIR: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const response = await request(child, {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "submit_report",
          arguments: { status: "completed", report: "final" },
        },
      });
      expect(response).toMatchObject({ id: 9, error: { code: -32603 } });
    } finally {
      child.kill();
    }
  });
});
