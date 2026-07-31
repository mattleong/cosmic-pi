// Fixture process/files are intentional boundary tests.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/preferSchemaOverJson:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/newPromise:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCli } from "../src/boundary/herdr-cli.ts";

const fixture = fileURLToPath(new URL("./fixtures/herdr-cli-fixture.mjs", import.meta.url));
const directories: string[] = [];

const setup = async (mode = "ok", timeout = 1_000) => {
  await fs.chmod(fixture, 0o755);
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-herdr-cli-"));
  directories.push(directory);
  const log = join(directory, "calls.jsonl");
  const config = join(directory, "scenario.json");
  await fs.writeFile(config, JSON.stringify({ mode, log }));
  const environment = {
    HOME: directory,
    PATH: process.env.PATH,
    HERDR_CONFIG_PATH: config,
    HERDR_SOCKET_PATH: "/private/inherited-herdr.sock",
  };
  return {
    log,
    environment,
    cli: makeHerdrCli({
      executable: fixture,
      runtimeExecutables: { pi: fixture, claude: fixture, codex: fixture },
      environment,
      commandTimeoutMillis: timeout,
    }),
  };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded Herdr CLI boundary", () => {
  it("uses only inherited Herdr session environment and fixed argv", async () => {
    const test = await setup();
    await Effect.runPromise(test.cli.preflight("pi"));
    const created = await Effect.runPromise(test.cli.createWorkspace("/project", "owned label"));
    expect(created).toMatchObject({ workspaceId: "w-owned", tabId: "w-owned:t1" });
    const calls = (await fs.readFile(test.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; socket: string });
    expect(calls.every((call) => !call.args.includes("--session"))).toBe(true);
    expect(calls.every((call) => call.socket === "/private/inherited-herdr.sock")).toBe(true);
    expect(calls.at(-1)?.args).toEqual([
      "workspace",
      "create",
      "--cwd",
      "/project",
      "--label",
      "owned label",
      "--no-focus",
    ]);
  });

  it("pins the inherited Herdr session environment at construction", async () => {
    const test = await setup();
    test.environment.HERDR_SOCKET_PATH = "/redirected/later.sock";
    const previousSocket = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = "/redirected/process.sock";
    try {
      await Effect.runPromise(test.cli.preflight("pi"));
      await Effect.runPromise(test.cli.createWorkspace("/project", "owned"));
    } finally {
      if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = previousSocket;
    }
    const calls = (await fs.readFile(test.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { socket: string });
    expect(calls.every((call) => call.socket === "/private/inherited-herdr.sock")).toBe(true);
    expect(test.cli.sessionIdentity).toBe("/private/inherited-herdr.sock");
  });

  it("fails typed on malformed and oversized JSON", async () => {
    const malformed = await setup("malformed");
    await expect(Effect.runPromise(malformed.cli.snapshot)).rejects.toMatchObject({
      _tag: "SubagentProcessError",
      code: "herdr_json_invalid",
    });
    const oversized = await setup("oversized");
    await expect(Effect.runPromise(oversized.cli.snapshot)).rejects.toMatchObject({
      _tag: "SubagentProcessError",
      code: "herdr_output_too_large",
    });

    await expect(
      Effect.runPromise(malformed.cli.createWorkspace("/project", "owned")),
    ).rejects.toMatchObject({
      code: "herdr_create_workspace_outcome_uncertain",
    });
    await expect(
      Effect.runPromise(oversized.cli.createWorkspace("/project", "owned")),
    ).rejects.toMatchObject({
      code: "herdr_create_workspace_outcome_uncertain",
    });
  });

  it("owns an in-flight mutation through cancellation until its bounded outcome", async () => {
    const sleeping = await setup("sleep", 100);
    const controller = new AbortController();
    const started = Date.now();
    const mutation = Effect.runPromise(sleeping.cli.createWorkspace("/project", "owned"), {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(mutation).rejects.toBeDefined();
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });

  it("distinguishes readiness timeout from post-ownership outcome uncertainty", async () => {
    const sleeping = await setup("sleep", 25);
    await expect(Effect.runPromise(sleeping.cli.preflight("pi"))).rejects.toMatchObject({
      _tag: "InvalidSubagentRequestError",
      code: "herdr_cli_timeout",
    });
    await expect(
      Effect.runPromise(sleeping.cli.createWorkspace("/project", "owned")),
    ).rejects.toMatchObject({
      _tag: "SubagentProcessError",
      code: "herdr_create_workspace_outcome_uncertain",
    });
  });
});
