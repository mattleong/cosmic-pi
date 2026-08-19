// Herdr CLI readiness owns bounded Node process and temporary-file test seams.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCli } from "../src/boundary/herdr-cli.ts";

const fixtureExecutable = fileURLToPath(
  new URL("./fixtures/herdr-cli-fixture.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];
const CommandLogSchema = Schema.Struct({ pane: Schema.NullOr(Schema.String) });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const makeFixtureCli = async (mode = "ok") => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-herdr-cli-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "config.json");
  const logPath = join(directory, "commands.jsonl");
  await writeFile(configPath, JSON.stringify({ mode, log: logPath }));
  const environment: NodeJS.ProcessEnv = {
    HOME: directory,
    PATH: process.env.PATH,
    HERDR_CONFIG_PATH: configPath,
    HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
    HERDR_ENV: "1",
    HERDR_WORKSPACE_ID: "user",
    HERDR_TAB_ID: "user:t",
    HERDR_PANE_ID: "user:p0",
  };
  return {
    cli: makeHerdrCli({
      executable: fixtureExecutable,
      environment,
      runtimeExecutables: { pi: fixtureExecutable },
    }),
    logPath,
  };
};

describe("Herdr calling-pane readiness", () => {
  it("skips before any CLI process when Pi has no inherited calling pane", async () => {
    const cli = makeHerdrCli({
      executable: "/definitely/missing/herdr",
      environment: { HERDR_SOCKET_PATH: "/private/herdr.sock" },
    });

    await expect(Effect.runPromise(cli.preflight("pi"))).rejects.toMatchObject({
      code: "herdr_calling_pane_required",
    });
  });

  it("accepts one exact live inherited calling pane and preserves its selector", async () => {
    const { cli, logPath } = await makeFixtureCli();
    await Effect.runPromise(cli.preflight("pi"));

    const commands = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => Schema.decodeUnknownSync(CommandLogSchema)(JSON.parse(line)));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((command) => command.pane === "user:p0")).toBe(true);
  });

  it("skips when pane-current evidence disagrees with the inherited selector", async () => {
    const { cli } = await makeFixtureCli("current-pane-mismatch");

    await expect(Effect.runPromise(cli.preflight("pi"))).rejects.toMatchObject({
      code: "herdr_calling_pane_unresolvable",
    });
  });
});
