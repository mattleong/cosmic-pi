// Private hook-trust fixture IO is intentional boundary-test behavior.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/newPromise:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it } from "vitest";
import { makeHerdrCodexHooks } from "../src/boundary/herdr-codex-hooks.ts";

const fixture = fileURLToPath(new URL("./fixtures/codex-hook-trust-fixture.mjs", import.meta.url));
const directories: string[] = [];

const setup = async (mode = "ok") => {
  const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-codex-hooks-"));
  directories.push(directory);
  const codexHome = join(directory, "codex-home");
  await fs.mkdir(codexHome, { mode: 0o700 });
  const configPath = join(codexHome, "config.toml");
  const hooksPath = join(codexHome, "hooks.json");
  const command = `node ${join(directory, "private-session-hook.mjs")}`;
  await fs.writeFile(join(codexHome, "fixture-mode"), mode, { mode: 0o600 });
  await fs.writeFile(configPath, "[features]\nhooks = true\n", { mode: 0o600 });
  await fs.writeFile(
    hooksPath,
    `${JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command, timeout: 10 }] }],
      },
    })}\n`,
    { mode: 0o600 },
  );
  const hooks = makeHerdrCodexHooks({
    executable: fixture,
    environment: {
      HOME: directory,
      PATH: process.env.PATH,
    },
    timeoutMillis: 2_000,
  });
  return {
    hooks,
    input: { codexHome, configPath, hooksPath, cwd: process.cwd(), command },
    pidPath: join(codexHome, "fixture.pid"),
  };
};

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForPid = async (path: string): Promise<number> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await fs.readFile(path, "utf8").catch(() => undefined);
    const pid = value === undefined ? undefined : Number(value);
    if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Codex hook fixture pid was not published");
};

const waitForDead = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("Herdr Codex hook trust", () => {
  it("round-trips Codex's opaque key and hash and confirms the exact hook is trusted", async () => {
    const test = await setup();
    await expect(Effect.runPromise(test.hooks.establishTrust(test.input))).resolves.toBeUndefined();
  });

  it.each(["extra", "wrong-command", "disabled", "warning", "modified", "overridden"])(
    "fails closed for %s hook evidence",
    async (mode) => {
      const test = await setup(mode);
      await expect(Effect.runPromise(test.hooks.establishTrust(test.input))).rejects.toMatchObject({
        _tag: "HerdrCodexHooksError",
        code: "codex_herdr_hook_unavailable",
      });
    },
  );

  it.each(["malformed", "exit", "timeout"])("bounds %s transport failure", async (mode) => {
    const test = await setup(mode);
    await expect(Effect.runPromise(test.hooks.establishTrust(test.input))).rejects.toMatchObject({
      _tag: "HerdrCodexHooksError",
      code: "codex_herdr_hook_unavailable",
    });
  });

  it("closes the scoped app-server when trust establishment is interrupted", async () => {
    const test = await setup("timeout");
    const fiber = Effect.runFork(test.hooks.establishTrust(test.input));
    const pid = await waitForPid(test.pidPath);

    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitForDead(pid);
    expect(processAlive(pid)).toBe(false);
  });
});
