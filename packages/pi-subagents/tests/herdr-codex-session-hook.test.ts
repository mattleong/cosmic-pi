// Packaged child-hook execution is intentional boundary-test process IO.
import { fileURLToPath } from "node:url";
import { deferredPromise } from "pi-cosmic-core/testing";
import { afterEach, describe, expect } from "vitest";
import { effectTest, step } from "./support/effect-test.ts";
import { nodeFsPromises as fs, nodePath, nodeSpawn as spawn } from "./support/node-builtins.ts";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectories,
} from "./support/temporary-directories.ts";

const { dirname, join } = nodePath;

const hook = fileURLToPath(
  new URL("../src/boundary/herdr-codex-session-hook.mjs", import.meta.url),
);

const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const run = (
  args: ReadonlyArray<string>,
  input: string,
  environment: NodeJS.ProcessEnv,
  executableHook = hook,
): Promise<{ readonly code: number | null; readonly stdout: string }> => {
  const settled = deferredPromise<{ readonly code: number | null; readonly stdout: string }>();
  const child = spawn(process.execPath, [executableHook, ...args], {
    env: environment,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.once("error", settled.reject);
  child.once("close", (code) => settled.resolve({ code, stdout }));
  child.stdin?.end(input);
  return settled.promise;
};

afterEach(removeTemporaryDirectories);

describe("Herdr Codex SessionStart compatibility hook", () => {
  effectTest(
    "adapts a nullable transcript for the validated integration and stops bootstrap inference",
    function* () {
      const directory = yield* step(() =>
        makeTemporaryDirectory("pi-subagents-codex-session-hook-"),
      );
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

  effectTest(
    "blocks bootstrap inference on invalid lifecycle input from an installed node_modules path",
    function* () {
      const directory = yield* step(() =>
        makeTemporaryDirectory("pi-subagents-installed-session-hook-"),
      );
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
