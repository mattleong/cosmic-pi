// Packaged child-hook execution is intentional boundary-test process IO.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/processEnv:off
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const hook = fileURLToPath(
  new URL("../src/boundary/herdr-codex-session-hook.mjs", import.meta.url),
);
const directories: string[] = [];

const run = (
  args: ReadonlyArray<string>,
  input: string,
  environment: NodeJS.ProcessEnv,
  executableHook = hook,
): Promise<{ readonly code: number | null; readonly stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executableHook, ...args], {
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
    child.stdin.end(input);
  });

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Herdr Codex SessionStart compatibility hook", () => {
  it("adapts a nullable transcript for the validated integration and stops bootstrap inference", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-codex-session-hook-"));
    directories.push(directory);
    const integration = join(directory, "integration.sh");
    const capture = join(directory, "capture.json");
    const fallback = join(directory, "session-anchor.jsonl");
    await fs.writeFile(fallback, "\n", { mode: 0o600 });
    await fs.writeFile(integration, `#!/bin/sh\ncat > '${capture}'\n`, { mode: 0o700 });
    const result = await run(
      [integration, fallback],
      `${JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "thread-1",
        transcript_path: null,
      })}\n`,
      {
        HOME: directory,
        PATH: process.env.PATH,
        HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
        HERDR_PANE_ID: "w:p1",
      },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      continue: false,
      stopReason: expect.stringContaining("bootstrap"),
    });
    expect(JSON.parse(await fs.readFile(capture, "utf8"))).toMatchObject({
      session_id: "thread-1",
      transcript_path: fallback,
    });
  });

  it("still blocks bootstrap inference when lifecycle input is invalid", async () => {
    const result = await run([], "{not-json", { PATH: process.env.PATH });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ continue: false });
  });

  it("runs from an installed node_modules path without TypeScript package loading", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-installed-session-hook-"));
    directories.push(directory);
    const installed = join(
      directory,
      "node_modules",
      "pi-subagents",
      "src",
      "boundary",
      "herdr-codex-session-hook.mjs",
    );
    await fs.mkdir(dirname(installed), { recursive: true });
    await fs.copyFile(hook, installed);
    const result = await run([], "{not-json", { PATH: process.env.PATH }, installed);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ continue: false });
  });
});
