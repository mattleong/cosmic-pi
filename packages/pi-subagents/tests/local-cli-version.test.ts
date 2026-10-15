import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { classifyCliVersion } from "../src/backend/local-cli-version.ts";
import { makeLocalCliProcess } from "../src/boundary/local-cli-process.ts";
import { step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

// A signed-in Claude Code or Codex stand-in that logs each invocation beside its version text.
const CLI_SCRIPT = `#!/bin/sh
echo "$*" >> "$HOME/cli-fixture.log"
case "$*" in
  --version) cat "$HOME/cli-version.txt" ;;
  "auth status --json") echo '{"loggedIn":true}' ;;
  *) exit 1 ;;
esac
`;
const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const versionedCli = (versionOutput: string) =>
  Effect.gen(function* () {
    const directory = yield* temporaryDirectory("pi-subagents-cli-version-");
    const home = nodePath.join(directory, "home");
    const agentDirectory = nodePath.join(directory, "agent");
    const executable = nodePath.join(directory, "cli");
    yield* step(() => fs.mkdir(home, { mode: 0o700 }));
    yield* step(() => fs.mkdir(agentDirectory, { mode: 0o700 }));
    yield* step(() => fs.writeFile(executable, CLI_SCRIPT, { mode: 0o700 }));
    yield* step(() => fs.writeFile(nodePath.join(home, "cli-version.txt"), `${versionOutput}\n`));
    const processes = makeLocalCliProcess({
      agentDirectory,
      environment: {
        HOME: home,
        PATH: inheritedPath(process.env),
        OPENAI_API_KEY: "fixture-api-key",
      },
      executables: { claude: executable, codex: executable },
    });
    const versionProbes = Effect.promise(() =>
      fs
        .readFile(nodePath.join(home, "cli-fixture.log"), "utf8")
        .then((log) => log.split("\n").filter((line) => line === "--version").length),
    );
    return { processes, versionProbes };
  });

const preflight = (
  processes: ReturnType<typeof makeLocalCliProcess>,
  runtime: "claude" | "codex",
) =>
  processes.preflight({
    runtime,
    context: "fresh",
    writeIntent: "read-only",
    closeOnReport: true,
    model: "fixture-model",
    effort: "high",
  });

describe("local CLI versions", () => {
  it.each([
    ["claude", "2.1.300 (Claude Code)", "supported"],
    ["claude", "2.1.224 (Claude Code)", "supported"],
    ["claude", "2.1.100 (Claude Code)", "unsupported"],
    ["claude", "2026.4.24 macos-arm64 (2026-04-27)", "supported"],
    ["codex", "codex-cli 0.162.1", "supported"],
    ["codex", "codex-cli 0.144.9", "unsupported"],
    ["codex", "codex-cli 0.145.0-alpha.3", "supported"],
    ["claude", "Claude Code (development build)", "unrecognized"],
  ] as const)("judges %s %j as %s", (runtime, output, status) => {
    expect(classifyCliVersion(runtime, output).status).toBe(status);
  });

  for (const runtime of ["claude", "codex"] as const) {
    it.live(`skips a ${runtime} route whose CLI is older than the supported minimum`, () =>
      Effect.gen(function* () {
        const { processes } = yield* versionedCli(
          runtime === "claude" ? "2.1.100 (Claude Code)" : "codex-cli 0.120.0",
        );
        const failure = yield* Effect.flip(preflight(processes, runtime));
        expect(failure.code).toBe(`${runtime}_version_unsupported`);
      }),
    );
  }

  it.live("admits an unrecognized version format instead of blocking", () =>
    Effect.gen(function* () {
      const { processes } = yield* versionedCli("Claude Code (development build)");
      yield* preflight(processes, "claude");
      expect(yield* processes.version?.("claude") ?? Effect.void).toMatchObject({
        status: "unrecognized",
      });
    }),
  );

  it.live("probes each CLI's version once per session", () =>
    Effect.gen(function* () {
      const { processes, versionProbes } = yield* versionedCli("2.1.300 (Claude Code)");
      yield* preflight(processes, "claude");
      yield* preflight(processes, "claude");
      expect(yield* processes.version?.("claude") ?? Effect.void).toEqual({
        status: "supported",
        version: "2.1.300",
      });
      expect(yield* versionProbes).toBe(1);
    }),
  );
});
