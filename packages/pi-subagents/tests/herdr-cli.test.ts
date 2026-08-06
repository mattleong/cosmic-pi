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
    PI_CODING_AGENT_DIR: "/private/pi-agent",
    CLAUDE_CONFIG_DIR: "/private/claude-config",
    CODEX_HOME: "/private/codex-home",
    SECRET: "must-not-cross",
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
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            socket: string;
            piDirectory: string;
            claudeDirectory: string;
            codexHome: string;
            secret: string | null;
          },
      );
    expect(calls.every((call) => !call.args.includes("--session"))).toBe(true);
    expect(calls.every((call) => call.socket === "/private/inherited-herdr.sock")).toBe(true);
    expect(calls.every((call) => call.piDirectory === "/private/pi-agent")).toBe(true);
    expect(calls.every((call) => call.claudeDirectory === "/private/claude-config")).toBe(true);
    expect(calls.every((call) => call.codexHome === "/private/codex-home")).toBe(true);
    expect(calls.every((call) => call.secret === null)).toBe(true);
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

  it("rejects a default session without an inherited socket before sterile harness ownership", async () => {
    const test = await setup();
    const cli = makeHerdrCli({
      executable: fixture,
      runtimeExecutables: { pi: fixture },
      environment: { ...test.environment, HERDR_SOCKET_PATH: undefined },
    });
    await expect(Effect.runPromise(cli.preflight("pi"))).rejects.toMatchObject({
      _tag: "InvalidSubagentRequestError",
      code: "herdr_socket_required",
    });
  });

  it("rejects control-bearing inherited CLI values before running Herdr", async () => {
    const test = await setup();
    const cli = makeHerdrCli({
      executable: fixture,
      runtimeExecutables: { pi: fixture },
      environment: { ...test.environment, PATH: "bad\u0085path" },
    });
    await expect(Effect.runPromise(cli.preflight("pi"))).rejects.toMatchObject({
      _tag: "InvalidSubagentRequestError",
      code: "herdr_environment_invalid",
    });
  });

  it("accepts Herdr 0.8's silent successful pane-run dispatch", async () => {
    const test = await setup();
    await expect(
      Effect.runPromise(
        test.cli.runPaneCommand(
          "w-owned:p1",
          "printf '%s\\n' pi-subagents-env-abc",
          "prepare pane environment",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("uses the fixed Herdr 0.8 pane-output attestation argv", async () => {
    const test = await setup();
    await Effect.runPromise(
      test.cli.waitPaneOutput("w-owned:p1", "pi-subagents-env-abc", "confirm pane environment"),
    );
    const calls = (await fs.readFile(test.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(calls.at(-1)?.args).toEqual([
      "pane",
      "wait-output",
      "w-owned:p1",
      "--match",
      "pi-subagents-env-abc",
      "--source",
      "recent",
      "--lines",
      "40",
      "--timeout",
      "5000",
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

  it("decodes Herdr 0.8 protocol-19 JSON when UTF-8 code points cross process chunks", async () => {
    const test = await setup("split-unicode");
    await expect(Effect.runPromise(test.cli.snapshot)).resolves.toMatchObject({
      version: "0.8.0",
      protocol: 19,
      workspaces: [{ workspaceId: "w-unicode", label: "owned-😀" }],
    });
  });

  it("rejects a newer incompatible Herdr protocol before live-server or topology ownership", async () => {
    const test = await setup("future-protocol");
    await expect(Effect.runPromise(test.cli.preflight("pi"))).rejects.toMatchObject({
      _tag: "InvalidSubagentRequestError",
      code: "herdr_protocol_unsupported",
    });
    const calls = (await fs.readFile(test.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(calls.map((call) => call.args)).toEqual([["api", "schema", "--json"]]);
  });

  it("fails readiness when the bundled Herdr 0.8 protocol and selected live server differ", async () => {
    const test = await setup("live-protocol-mismatch");
    await expect(Effect.runPromise(test.cli.preflight("pi"))).rejects.toMatchObject({
      _tag: "InvalidSubagentRequestError",
      code: "herdr_protocol_mismatch",
    });
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
    const oversizedStderr = await setup("oversized-stderr");
    await expect(Effect.runPromise(oversizedStderr.cli.snapshot)).rejects.toMatchObject({
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

  it("recognizes Herdr 0.8 pre-application agent-start rejections without weakening uncertain failures", async () => {
    const input = {
      runtime: "pi" as const,
      paneId: "w-owned:p1",
      agentName: "invalid name",
      argv: [] as const,
    };
    const rejected = await setup("invalid-agent-name");
    await expect(Effect.runPromise(rejected.cli.startAgent(input))).rejects.toMatchObject({
      _tag: "SubagentProcessError",
      code: "invalid_agent_name",
    });

    const uncertain = await setup("agent-start-timeout");
    await expect(Effect.runPromise(uncertain.cli.startAgent(input))).rejects.toMatchObject({
      _tag: "SubagentProcessError",
      code: "herdr_start_agent_outcome_uncertain",
    });

    // Herdr uses this code both before dispatch and after the runtime accepted input,
    // so it must never be downgraded to a confirmed pre-application rejection.
    const unavailable = await setup("agent-pane-unavailable");
    await expect(Effect.runPromise(unavailable.cli.startAgent(input))).rejects.toMatchObject({
      _tag: "SubagentProcessError",
      code: "herdr_start_agent_outcome_uncertain",
    });
  });
});
