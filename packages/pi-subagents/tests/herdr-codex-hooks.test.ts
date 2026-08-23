// Private hook-trust fixture IO is intentional boundary-test behavior.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCodexHooks } from "../src/boundary/herdr-codex-hooks.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const { join } = nodePath;

const fixture = fileURLToPath(new URL("./fixtures/codex-hook-trust-fixture.mjs", import.meta.url));
const directories: string[] = [];

const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const setup = (mode = "ok") =>
  fs.mkdtemp(join(tmpdir(), "pi-subagents-codex-hooks-")).then((directory) => {
    directories.push(directory);
    const codexHome = join(directory, "codex-home");
    const configPath = join(codexHome, "config.toml");
    const hooksPath = join(codexHome, "hooks.json");
    const command = `node ${join(directory, "private-session-hook.mjs")}`;
    return fs
      .mkdir(codexHome, { mode: 0o700 })
      .then(() => fs.writeFile(join(codexHome, "fixture-mode"), mode, { mode: 0o600 }))
      .then(() => fs.writeFile(configPath, "[features]\nhooks = true\n", { mode: 0o600 }))
      .then(() =>
        fs.writeFile(
          hooksPath,
          `${JSON.stringify({
            hooks: {
              SessionStart: [
                { matcher: "startup", hooks: [{ type: "command", command, timeout: 10 }] },
              ],
            },
          })}\n`,
          { mode: 0o600 },
        ),
      )
      .then(() => ({
        hooks: makeHerdrCodexHooks({
          executable: fixture,
          environment: {
            HOME: directory,
            PATH: inheritedPath(process.env),
          },
          timeoutMillis: 2_000,
        }),
        input: { codexHome, configPath, hooksPath, cwd: process.cwd(), command },
        pidPath: join(codexHome, "fixture.pid"),
      }));
  });

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Real-time polling of live child processes deliberately runs on the live default clock.
const waitForPid = (path: string): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt++) {
        const value = yield* Effect.promise(() => fs.readFile(path, "utf8").catch(() => undefined));
        const pid = value === undefined ? undefined : Number(value);
        if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) return pid;
        yield* Effect.sleep(Duration.millis(10));
      }
      return yield* Effect.die(new Error("Codex hook fixture pid was not published"));
    }),
  );

const waitForDead = (pid: number): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
        yield* Effect.sleep(Duration.millis(10));
    }),
  );

afterEach(() =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined),
);

describe("Herdr Codex hook trust", () => {
  it("round-trips Codex's opaque key and hash and confirms the exact hook is trusted", () =>
    setup().then((test) =>
      expect(Effect.runPromise(test.hooks.establishTrust(test.input))).resolves.toBeUndefined(),
    ));

  it.each(["extra", "wrong-command", "disabled", "warning", "modified", "overridden"])(
    "fails closed for %s hook evidence",
    (mode) =>
      setup(mode).then((test) =>
        expect(Effect.runPromise(test.hooks.establishTrust(test.input))).rejects.toMatchObject({
          _tag: "HerdrCodexHooksError",
          code: "codex_herdr_hook_unavailable",
        }),
      ),
  );

  it.each(["malformed", "exit", "timeout"])("bounds %s transport failure", (mode) =>
    setup(mode).then((test) =>
      expect(Effect.runPromise(test.hooks.establishTrust(test.input))).rejects.toMatchObject({
        _tag: "HerdrCodexHooksError",
        code: "codex_herdr_hook_unavailable",
      }),
    ),
  );

  it("closes the scoped app-server when trust establishment is interrupted", () =>
    setup("timeout").then((test) => {
      const fiber = Effect.runFork(test.hooks.establishTrust(test.input));
      return waitForPid(test.pidPath).then((pid) =>
        Effect.runPromise(Fiber.interrupt(fiber))
          .then(() => waitForDead(pid))
          .then(() => {
            expect(processAlive(pid)).toBe(false);
          }),
      );
    }));
});
