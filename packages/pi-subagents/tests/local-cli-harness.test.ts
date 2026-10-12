import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import { deferredPromise, temporaryDirectory, yieldUntil } from "pi-cosmic-core/testing";
import {
  prepareLocalCliHarness,
  sanitizeLocalCliEnvironment,
} from "../src/boundary/local-cli-harness.ts";
import { makeLocalCliProcess } from "../src/boundary/local-cli-process.ts";
import * as localCliTransport from "../src/boundary/local-cli-transport.ts";
import { backendLaunch, supervisorMetadata } from "./fixtures/backend-supervisor.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const executable = fileURLToPath(new URL("./fixtures/local-cli-fixture.mjs", import.meta.url));
const inheritedPath = (source: NodeJS.ProcessEnv): string | undefined => source.PATH;

const setup = Effect.gen(function* () {
  const directory = yield* temporaryDirectory("pi-subagents-local-cli-harness-");
  const agentDirectory = nodePath.join(directory, "agent");
  const home = nodePath.join(directory, "home");
  yield* Effect.promise(() => fs.mkdir(agentDirectory, { mode: 0o700 }));
  yield* Effect.promise(() => fs.mkdir(home, { mode: 0o700 }));
  return {
    directory,
    agentDirectory,
    environment: { HOME: home, PATH: inheritedPath(process.env) },
  };
});

const supervisor = (directory: string) =>
  supervisorMetadata({
    stateDirectory: nodePath.join(directory, "supervisor"),
    connectionConfigPath: nodePath.join(directory, "supervisor", "connection.json"),
    args: ["/private/helper.mjs", "--config", "/private/connection.json"],
  });

const harnessEntries = (agentDirectory: string) =>
  fs.readdir(nodePath.join(agentDirectory, "subagents", "local-cli-v1")).catch((cause: unknown) => {
    if (Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") return [];
    throw cause;
  });

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
      const test = yield* setup;
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

  it.effect("interrupts spawn during agent-directory lookup before private ownership", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const stat = yield* Effect.promise(() => fs.lstat(test.agentDirectory));
      const entered = Deferred.makeUnsafe<void>();
      const gate = deferredPromise();
      const lookup = vi.spyOn(fs, "lstat").mockImplementationOnce(() => {
        Deferred.doneUnsafe(entered, Effect.void);
        return gate.promise.then(() => stat);
      });
      const spawn = vi.spyOn(localCliTransport, "acquireLocalCliTransport");
      yield* Effect.gen(function* () {
        const target = yield* makeLocalCliProcess({
          agentDirectory: test.agentDirectory,
          environment: test.environment,
          executables: { claude: executable, codex: executable },
        })
          .spawn({
            runtime: "claude",
            launch: backendLaunch(),
            supervisor: supervisor(test.directory),
          })
          .pipe(Effect.scoped, Effect.forkScoped);
        yield* Deferred.await(entered);
        const interrupted = yield* Fiber.interrupt(target).pipe(Effect.forkScoped);
        yield* yieldUntil(() => interrupted.pollUnsafe() !== undefined);
        yield* Fiber.join(interrupted);
        expect(Exit.hasInterrupts(yield* Fiber.await(target))).toBe(true);
        expect(spawn).not.toHaveBeenCalled();
        expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            gate.resolve();
            lookup.mockRestore();
            spawn.mockRestore();
          }),
        ),
      );
    }),
  );

  it.live("does not leak a harness when interrupted during masked preparation", () =>
    Effect.gen(function* () {
      const test = yield* setup;
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
      const test = yield* setup;
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
