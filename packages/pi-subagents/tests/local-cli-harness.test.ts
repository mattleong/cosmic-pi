// Private harness lifecycle tests intentionally exercise real filesystem and process ownership.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type { BackendLaunchRequest } from "../src/backend/model.ts";
import {
  prepareLocalCliHarness,
  sanitizeLocalCliEnvironment,
} from "../src/boundary/local-cli-harness.ts";
import { makeLocalCliProcess } from "../src/boundary/local-cli-process.ts";
import { supervisorMetadata } from "./fixtures/backend-supervisor.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const { join } = nodePath;
const executable = fileURLToPath(new URL("./fixtures/local-cli-fixture.mjs", import.meta.url));
const directories: string[] = [];
const deferredPromise = (deferred: Deferred.Deferred<void>): Promise<void> =>
  Effect.runPromise(Deferred.await(deferred));
const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const setup = () =>
  fs.mkdtemp(join(tmpdir(), "pi-subagents-local-cli-harness-")).then((directory) => {
    directories.push(directory);
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
  supervisorMetadata("agent-local-cli", {
    stateDirectory: join(directory, "supervisor"),
    connectionConfigPath: join(directory, "supervisor", "connection.json"),
    args: ["/private/helper.mjs", "--config", "/private/connection.json"],
  });

const launch = (): BackendLaunchRequest => ({
  runId: "agent-local-cli",
  name: "local-cli-worker",
  closeOnReport: true,
  cwd: process.cwd(),
  context: "fresh",
  writeIntent: "read-only",
  openaiFastMode: false,
  model: "claude-fixture",
  effort: "high",
  activeTools: [],
  projectTrusted: false,
  parentSessionId: "parent-session",
  systemPrompt: "Use the private supervisor.",
});

const harnessEntries = (agentDirectory: string) =>
  fs
    .readdir(join(agentDirectory, "subagents", "local-cli-v1"))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });

afterEach(() =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined),
);

describe("local CLI harness ownership", () => {
  it("keeps adapter debug controls out of the child environment", () => {
    const sanitized = sanitizeLocalCliEnvironment(
      {
        PATH: inheritedPath(process.env),
        PI_SUBAGENTS_CLAUDE_DEBUG: "1",
      },
      "claude",
      launch(),
    );
    expect(sanitized.PI_SUBAGENTS_CLAUDE_DEBUG).toBeUndefined();
  });

  it.effect("removes a partially populated harness after preparation fails", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(setup);
      const error = yield* Effect.flip(
        prepareLocalCliHarness(
          {
            agentDirectory: test.agentDirectory,
            environment: test.environment,
            harnessFault: "after-claude-settings",
          },
          { runtime: "claude", launch: launch(), supervisor: supervisor(test.directory) },
        ),
      );
      expect(error.reason).toBe("prepare_failed");
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
    }),
  );

  it.effect("fails closed when partial-harness cleanup cannot be confirmed", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(setup);
      const error = yield* Effect.flip(
        prepareLocalCliHarness(
          {
            agentDirectory: test.agentDirectory,
            environment: test.environment,
            harnessFault: "after-claude-settings",
            harnessCleanupFault: true,
          },
          { runtime: "claude", launch: launch(), supervisor: supervisor(test.directory) },
        ),
      );
      expect(error.reason).toBe("cleanup_unconfirmed");
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toHaveLength(1);
    }),
  );

  it.live("does not leak a harness when interrupted during masked preparation", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(setup);
      const entered = Deferred.makeUnsafe<void>();
      const gate = Deferred.makeUnsafe<void>();
      const service = makeLocalCliProcess({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        executables: { claude: executable, codex: executable },
        afterHarnessDirectoryCreated: () => {
          Deferred.doneUnsafe(entered, Effect.void);
          return deferredPromise(gate);
        },
      });
      const target = yield* Effect.scoped(
        service.spawn({
          runtime: "claude",
          launch: launch(),
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
      Deferred.doneUnsafe(gate, Effect.void);
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
          launch: launch(),
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
