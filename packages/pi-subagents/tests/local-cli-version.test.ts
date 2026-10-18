import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { temporaryDirectory } from "pi-cosmic-core/testing";
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
    return { processes };
  });

const preflight = (
  processes: ReturnType<typeof makeLocalCliProcess>,
  runtime: "claude" | "codex",
) =>
  processes.preflight({
    runtime,
    context: "fresh",
    writeIntent: "read-only",
    model: "fixture-model",
    effort: "high",
  });

describe("local CLI versions", () => {
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
});
