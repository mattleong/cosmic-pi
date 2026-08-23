// Packaged child-hook execution is intentional boundary-test process IO.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vitest";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath, nodeSpawn as spawn } from "./support/node-builtins.ts";

const { dirname, join } = nodePath;

const hook = fileURLToPath(
  new URL("../src/boundary/herdr-codex-session-hook.mjs", import.meta.url),
);
const directories: string[] = [];

const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const run = (
  args: ReadonlyArray<string>,
  input: string,
  environment: NodeJS.ProcessEnv,
  executableHook = hook,
): Promise<{ readonly code: number | null; readonly stdout: string }> => {
  const settled = Deferred.makeUnsafe<{ readonly code: number | null; readonly stdout: string }>();
  const child = spawn(process.execPath, [executableHook, ...args], {
    env: environment,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.once("error", (error) => Deferred.doneUnsafe(settled, Effect.die(error)));
  child.once("close", (code) => Deferred.doneUnsafe(settled, Effect.succeed({ code, stdout })));
  child.stdin?.end(input);
  return Effect.runPromise(Deferred.await(settled));
};

afterEach(() =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined),
);

describe("Herdr Codex SessionStart compatibility hook", () => {
  effectTest(
    "adapts a nullable transcript for the validated integration and stops bootstrap inference",
    function* () {
      const directory = yield* step(() =>
        fs.mkdtemp(join(tmpdir(), "pi-subagents-codex-session-hook-")),
      );
      directories.push(directory);
      const integration = join(directory, "integration.sh");
      const capture = join(directory, "capture.json");
      const fallback = join(directory, "session-anchor.jsonl");
      yield* step(() => fs.writeFile(fallback, "\n", { mode: 0o600 }));
      yield* step(() =>
        fs.writeFile(integration, `#!/bin/sh\ncat > '${capture}'\n`, { mode: 0o700 }),
      );
      const result = yield* step(() =>
        run(
          [integration, fallback],
          `${JSON.stringify({
            hook_event_name: "SessionStart",
            source: "startup",
            session_id: "thread-1",
            transcript_path: null,
          })}\n`,
          {
            HOME: directory,
            PATH: inheritedPath(process.env),
            HERDR_SOCKET_PATH: join(directory, "herdr.sock"),
            HERDR_PANE_ID: "w:p1",
          },
        ),
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        continue: false,
        stopReason: expect.stringContaining("bootstrap"),
      });
      expect(JSON.parse(yield* step(() => fs.readFile(capture, "utf8")))).toMatchObject({
        session_id: "thread-1",
        transcript_path: fallback,
      });
    },
  );

  effectTest("still blocks bootstrap inference when lifecycle input is invalid", function* () {
    const result = yield* step(() => run([], "{not-json", { PATH: inheritedPath(process.env) }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ continue: false });
  });

  effectTest(
    "runs from an installed node_modules path without TypeScript package loading",
    function* () {
      const directory = yield* step(() =>
        fs.mkdtemp(join(tmpdir(), "pi-subagents-installed-session-hook-")),
      );
      directories.push(directory);
      const installed = join(
        directory,
        "node_modules",
        "pi-subagents",
        "src",
        "boundary",
        "herdr-codex-session-hook.mjs",
      );
      yield* step(() => fs.mkdir(dirname(installed), { recursive: true }));
      yield* step(() => fs.copyFile(hook, installed));
      const result = yield* step(() =>
        run([], "{not-json", { PATH: inheritedPath(process.env) }, installed),
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ continue: false });
    },
  );
});
