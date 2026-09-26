// Herdr CLI readiness owns bounded Node process and temporary-file test seams.
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect } from "vitest";
import { makeHerdrCli } from "../src/boundary/herdr-cli.ts";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises, nodePath } from "./support/node-builtins.ts";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectories,
} from "./support/temporary-directories.ts";

const { readFile, writeFile } = nodeFsPromises;
const { join } = nodePath;

const fixtureExecutable = fileURLToPath(
  new URL("./fixtures/herdr-cli-fixture.mjs", import.meta.url),
);
const CommandLogSchema = Schema.Struct({
  args: Schema.Array(Schema.String),
  pane: Schema.NullOr(Schema.String),
});

afterEach(removeTemporaryDirectories);

const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const makeFixtureCli = (mode = "ok", protocol?: number, liveProtocol?: number) =>
  makeTemporaryDirectory("pi-subagents-herdr-cli-").then((directory) => {
    const configPath = join(directory, "config.json");
    const logPath = join(directory, "commands.jsonl");
    return writeFile(
      configPath,
      JSON.stringify({ mode, protocol, liveProtocol, log: logPath }),
    ).then(() => {
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
    "accepts reviewed protocols with one exact live inherited calling pane and preserves its selector",
    function* () {
      for (const protocol of [20, 22]) {
        const { cli, logPath } = yield* step(() => makeFixtureCli("ok", protocol));
        yield* step(() => Effect.runPromise(cli.preflight("pi")));

        const commands = (yield* step(() => readFile(logPath, "utf8")))
          .trim()
          .split("\n")
          .map((line) => Schema.decodeUnknownSync(CommandLogSchema)(JSON.parse(line)));
        expect(commands.length).toBeGreaterThan(0);
        expect(commands.every((command) => command.pane === "user:p0")).toBe(true);
      }
    },
  );

  effectTest(
    "rejects unsupported or mismatched Herdr protocols and an unresolvable calling pane",
    function* () {
      for (const [mode, protocol, liveProtocol, code] of [
        ["legacy-protocol", undefined, undefined, "herdr_upgrade_required"],
        ["future-protocol", undefined, undefined, "herdr_protocol_unsupported"],
        ["live-protocol-mismatch", undefined, undefined, "herdr_protocol_mismatch"],
        ["ok", 21, 21, "herdr_protocol_unsupported"],
        ["ok", 22, 20, "herdr_protocol_mismatch"],
        ["ok", 20, 22, "herdr_protocol_mismatch"],
        ["current-pane-mismatch", undefined, undefined, "herdr_calling_pane_unresolvable"],
      ] as const) {
        const { cli } = yield* step(() => makeFixtureCli(mode, protocol, liveProtocol));
        yield* step(() =>
          expect(Effect.runPromise(cli.preflight("pi"))).rejects.toMatchObject({ code }),
        );
      }
    },
  );

  effectTest("treats agent_blocked as confirmed prompt non-application", function* () {
    const { cli } = yield* step(() => makeFixtureCli("agent-blocked"));
    yield* step(() =>
      expect(Effect.runPromise(cli.prompt("reviewer", "Continue"))).rejects.toMatchObject({
        operation: "prompt agent",
        code: "agent_blocked",
        message: "agent is waiting for approval or a user answer",
      }),
    );
  });
});
