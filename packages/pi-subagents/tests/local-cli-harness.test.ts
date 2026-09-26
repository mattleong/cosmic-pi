// Private harness lifecycle tests intentionally exercise real filesystem and process ownership.
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import { deferredPromise } from "pi-cosmic-core/testing";
import {
  prepareLocalCliHarness,
  sanitizeLocalCliEnvironment,
} from "../src/boundary/local-cli-harness.ts";
import { makeLocalCliProcess } from "../src/boundary/local-cli-process.ts";
import { backendLaunch, supervisorMetadata } from "./fixtures/backend-supervisor.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectories,
} from "./support/temporary-directories.ts";

const { join } = nodePath;
const executable = fileURLToPath(new URL("./fixtures/local-cli-fixture.mjs", import.meta.url));
const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const setup = () =>
  makeTemporaryDirectory("pi-subagents-local-cli-harness-").then((directory) => {
    const agentDirectory = join(directory, "agent");
    const home = join(directory, "home");
    return fs
      .mkdir(agentDirectory, { mode: 0o700 })
      .then(() => fs.mkdir(home, { mode: 0o700 }))
      .then(() => ({
        directory,
        agentDirectory,
        environment: { HOME: home, PATH: inheritedPath(process.env) },
      }));
  });

const supervisor = (directory: string) =>
  supervisorMetadata({
    stateDirectory: join(directory, "supervisor"),
    connectionConfigPath: join(directory, "supervisor", "connection.json"),
    args: ["/private/helper.mjs", "--config", "/private/connection.json"],
  });

const harnessEntries = (agentDirectory: string) =>
  fs
    .readdir(join(agentDirectory, "subagents", "local-cli-v1"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });

afterEach(removeTemporaryDirectories);

describe("local CLI harness ownership", () => {
  it("keeps adapter debug controls out of the child environment", () => {
    const sanitized = sanitizeLocalCliEnvironment(
      {
        PATH: inheritedPath(process.env),
        PI_SUBAGENTS_CLAUDE_DEBUG: "1",
      },
      "claude",
      backendLaunch(),
    );
    expect(sanitized.PI_SUBAGENTS_CLAUDE_DEBUG).toBeUndefined();
  });

  it.effect.each([
    ["removes a partially populated harness after preparation fails", false, "prepare_failed", 0],
    [
      "fails closed when partial-harness cleanup cannot be confirmed",
      true,
      "cleanup_unconfirmed",
      1,
    ],
  ] as const)("%s", ([, harnessCleanupFault, reason, remaining]) =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(setup);
      const error = yield* Effect.flip(
        prepareLocalCliHarness(
          {
            agentDirectory: test.agentDirectory,
            environment: test.environment,
            harnessFault: "after-claude-settings",
            harnessCleanupFault,
          },
          { runtime: "claude", launch: backendLaunch(), supervisor: supervisor(test.directory) },
        ),
      );
      expect(error.reason).toBe(reason);
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toHaveLength(
        remaining,
      );
    }),
  );

  it.live("does not leak a harness when interrupted during masked preparation", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(setup);
      const entered = Deferred.makeUnsafe<void>();
      const gate = deferredPromise();
      const service = makeLocalCliProcess({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        executables: { claude: executable, codex: executable },
        afterHarnessDirectoryCreated: () => {
          Deferred.doneUnsafe(entered, Effect.void);
          return gate.promise;
        },
      });
      const target = yield* Effect.scoped(
        service.spawn({
          runtime: "claude",
          launch: backendLaunch(),
          supervisor: supervisor(test.directory),
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toHaveLength(1);

      const interruptionSettled = yield* Ref.make(false);
      const interrupted = yield* Fiber.interrupt(target).pipe(
        Effect.ensuring(Ref.set(interruptionSettled, true)),
        Effect.forkScoped,
      );
      yield* Effect.sleep("20 millis");
      expect(yield* Ref.get(interruptionSettled)).toBe(false);
      gate.resolve();
      yield* Fiber.join(interrupted);
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("releases the process before removing its scoped harness", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(setup);
      const service = makeLocalCliProcess({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        executables: { claude: executable, codex: executable },
      });
      yield* service
        .spawn({
          runtime: "claude",
          launch: backendLaunch(),
          supervisor: supervisor(test.directory),
        })
        .pipe(
          Effect.tap(() =>
            Effect.promise(() => harnessEntries(test.agentDirectory)).pipe(
              Effect.tap((entries) => Effect.sync(() => expect(entries).toHaveLength(1))),
            ),
          ),
          Effect.scoped,
        );
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
    }),
  );
});
