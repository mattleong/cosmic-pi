// Private hook-trust fixture IO is intentional boundary-test behavior.
import { fileURLToPath } from "node:url";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHerdrCodexHooks } from "../src/boundary/herdr-codex-hooks.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";
import { processAlive, waitForDead, waitForPid } from "./support/process-liveness.ts";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectories,
} from "./support/temporary-directories.ts";

const { join } = nodePath;

const fixture = fileURLToPath(new URL("./fixtures/codex-hook-trust-fixture.mjs", import.meta.url));
const ChildProcess = process.getBuiltinModule("node:child_process")!.ChildProcess;

const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const setup = (mode = "ok", timeoutMillis = 2_000) =>
  makeTemporaryDirectory("pi-subagents-codex-hooks-").then((directory) => {
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
          timeoutMillis,
        }),
        input: { codexHome, configPath, hooksPath, cwd: process.cwd(), command },
        pidPath: join(codexHome, "fixture.pid"),
      }));
  });

const forceCloseFailure = () => {
  const kill = process.kill.bind(process);
  // SAFETY: The mock keeps process.kill's numeric PID and signal contract unchanged.
  const groupKill = vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (pid < 0) throw Object.assign(new Error("fixture group kill failed"), { code: "EACCES" });
    return kill(pid, signal);
  }) as typeof process.kill);
  const childKill = vi.spyOn(ChildProcess.prototype, "kill").mockReturnValue(false);
  return {
    kill,
    restore: () => {
      childKill.mockRestore();
      groupKill.mockRestore();
    },
  };
};

afterEach(removeTemporaryDirectories);

describe("Herdr Codex hook trust", () => {
  it("round-trips Codex's opaque key and hash and confirms the exact hook is trusted", () =>
    setup().then((test) =>
      expect(Effect.runPromise(test.hooks.establishTrust(test.input))).resolves.toBeUndefined(),
    ));

  it.each([
    "extra",
    "wrong-command",
    "disabled",
    "warning",
    "modified",
    "overridden",
    "malformed",
    "exit",
    "timeout",
  ])("fails closed for %s hook evidence or transport", (mode) =>
    setup(mode).then((test) =>
      expect(Effect.runPromise(test.hooks.establishTrust(test.input))).rejects.toMatchObject({
        _tag: "HerdrCodexHooksError",
        code: "codex_herdr_hook_unavailable",
      }),
    ),
  );

  it("fails closed on a numeric JSON-RPC error code without waiting for the call bound", () =>
    setup("rejected", 60_000).then((test) =>
      expect(Effect.runPromise(test.hooks.establishTrust(test.input))).rejects.toMatchObject({
        code: "codex_herdr_hook_unavailable",
      }),
    ));

  it("closes the scoped app-server when trust establishment is interrupted", () =>
    setup("timeout").then((test) => {
      const fiber = Effect.runFork(test.hooks.establishTrust(test.input));
      return waitForPid(test.pidPath).then((pid) =>
        Effect.runPromise(
          Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.join(fiber).pipe(Effect.exit))),
        )
          .then((interrupted) => {
            expect(Exit.isFailure(interrupted)).toBe(true);
            if (Exit.isFailure(interrupted))
              expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
            return waitForDead(pid);
          })
          .then(() => {
            expect(processAlive(pid)).toBe(false);
          }),
      );
    }));

  it("keeps cleanup failure primary without dropping transport or trust causes", () =>
    setup("timeout").then((test) => {
      const fiber = Effect.runFork(test.hooks.establishTrust(test.input));
      let forced: ReturnType<typeof forceCloseFailure> | undefined;
      return waitForPid(test.pidPath)
        .then((pid) => {
          forced = forceCloseFailure();
          forced.kill(pid, "SIGKILL");
          return waitForDead(pid);
        })
        .then(() => Effect.runPromise(Fiber.join(fiber).pipe(Effect.exit)))
        .then((exit) => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const codes = exit.cause.reasons.flatMap((reason) =>
              Cause.isFailReason(reason) ? [reason.error.code] : [],
            );
            expect(codes).toEqual([
              "codex_herdr_hook_cleanup_unconfirmed",
              "codex_herdr_hook_unavailable",
              "codex_herdr_hook_unavailable",
            ]);
          }
        })
        .finally(() => forced?.restore());
    }));

  it(
    "preserves interruption when explicit close also fails",
    () =>
      setup("timeout").then((test) => {
        const fiber = Effect.runFork(test.hooks.establishTrust(test.input));
        let forced: ReturnType<typeof forceCloseFailure> | undefined;
        let pid = 0;
        return waitForPid(test.pidPath)
          .then((observedPid) => {
            pid = observedPid;
            forced = forceCloseFailure();
            return Effect.runPromise(
              Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.join(fiber).pipe(Effect.exit))),
            );
          })
          .then((exit) => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.hasInterrupts(exit.cause)).toBe(true);
              const first = exit.cause.reasons[0];
              expect(first && Cause.isFailReason(first) ? first.error.code : undefined).toBe(
                "codex_herdr_hook_cleanup_unconfirmed",
              );
            }
          })
          .finally(() => {
            forced?.restore();
            try {
              forced?.kill(-pid, "SIGKILL");
            } catch {
              // The process may already have exited despite the forced cleanup failure.
            }
            return waitForDead(pid);
          });
      }),
    10_000,
  );
});
