// Herdr CLI readiness owns bounded Node process and temporary-file test seams.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect } from "vitest";
import { makeHerdrCli } from "../src/boundary/herdr-cli.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const { mkdtemp, readFile, rm, writeFile } = nodeFsPromises;
const { join } = nodePath;

const fixtureExecutable = fileURLToPath(
  new URL("./fixtures/herdr-cli-fixture.mjs", import.meta.url),
);
const temporaryDirectories: string[] = [];
const CommandLogSchema = Schema.Struct({ pane: Schema.NullOr(Schema.String) });

afterEach(() =>
  Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  ).then(() => undefined),
);

const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const makeFixtureCli = (mode = "ok") =>
  mkdtemp(join(tmpdir(), "pi-subagents-herdr-cli-")).then((directory) => {
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    const logPath = join(directory, "commands.jsonl");
    return writeFile(configPath, JSON.stringify({ mode, log: logPath })).then(() => {
      const environment: NodeJS.ProcessEnv = {
        HOME: directory,
        PATH: inheritedPath(process.env),
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
    });
  });

describe("Herdr calling-pane readiness", () => {
  effectTest("skips before any CLI process when Pi has no inherited calling pane", function* () {
    const cli = makeHerdrCli({
      executable: "/definitely/missing/herdr",
      environment: { HERDR_SOCKET_PATH: "/private/herdr.sock" },
    });

    yield* step(() =>
      expect(Effect.runPromise(cli.preflight("pi"))).rejects.toMatchObject({
        code: "herdr_calling_pane_required",
      }),
    );
  });

  effectTest(
    "accepts one exact live inherited calling pane and preserves its selector",
    function* () {
      const { cli, logPath } = yield* step(() => makeFixtureCli());
      yield* step(() => Effect.runPromise(cli.preflight("pi")));

      const commands = (yield* step(() => readFile(logPath, "utf8")))
        .trim()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(CommandLogSchema)(JSON.parse(line)));
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((command) => command.pane === "user:p0")).toBe(true);
    },
  );

  effectTest(
    "skips when pane-current evidence disagrees with the inherited selector",
    function* () {
      const { cli } = yield* step(() => makeFixtureCli("current-pane-mismatch"));

      yield* step(() =>
        expect(Effect.runPromise(cli.preflight("pi"))).rejects.toMatchObject({
          code: "herdr_calling_pane_unresolvable",
        }),
      );
    },
  );
});
