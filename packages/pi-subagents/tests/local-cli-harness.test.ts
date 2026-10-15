import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { deferredPromise, temporaryDirectory, yieldUntil } from "pi-cosmic-core/testing";
import {
  prepareLocalCliHarness,
  removeLocalCliHarness,
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

const SHARED_TEMPORARY_DIRECTORY = "/shared/tmp";

/** Codex needs a credential; the parent's temp variables name the shared temp directory. */
const codexEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  ...environment,
  OPENAI_API_KEY: "sk-fixture",
  TMPDIR: SHARED_TEMPORARY_DIRECTORY,
  TMP: SHARED_TEMPORARY_DIRECTORY,
  TEMP: SHARED_TEMPORARY_DIRECTORY,
});

/** What a child can leave behind: a directory tree without owner write or search access. */
const lockDirectoryTree = (directory: string) =>
  Effect.promise(() =>
    fs
      .mkdir(nodePath.join(directory, "cache", "module"), { recursive: true })
      .then(() => fs.writeFile(nodePath.join(directory, "cache", "module", "file.txt"), "x"))
      .then(() => fs.chmod(nodePath.join(directory, "cache", "module"), 0o500))
      .then(() => fs.chmod(nodePath.join(directory, "cache"), 0o000)),
  );

const harnessEntries = (agentDirectory: string) =>
  fs.readdir(nodePath.join(agentDirectory, "subagents", "local-cli-v1")).catch((cause: unknown) => {
    if (Predicate.hasProperty(cause, "code") && cause.code === "ENOENT") return [];
    throw cause;
  });

/** Claude temp roots a test created in its own parent rather than `/tmp`. */
const claudeTemporaryRoots = (parent: string) =>
  Effect.promise(() =>
    fs.readdir(parent).then((names) => names.filter((name) => name.startsWith("pi-claude-"))),
  );

const exists = (path: string) =>
  Effect.promise(() =>
    fs.lstat(path).then(
      () => true,
      () => false,
    ),
  );

const decodeClaudeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      sandbox: Schema.Struct({
        filesystem: Schema.Struct({ denyWrite: Schema.Array(Schema.String) }),
      }),
    }),
  ),
);

/** Claude Code keeps sandboxed Bash in `<root>/claude-<uid>` only while that fits in 44 bytes. */
const CLAUDE_SHORT_TEMPORARY_BYTES = 44;
const LARGEST_UID = 4_294_967_294;

describe("local CLI harness ownership", () => {
  it("passes proxy and certificate settings in either case", () => {
    const sanitized = sanitizeLocalCliEnvironment(
      {
        https_proxy: "http://proxy.local:8080",
        no_proxy: "localhost",
        NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
      },
      "codex",
      backendLaunch(),
    );
    expect(sanitized).toMatchObject({
      https_proxy: "http://proxy.local:8080",
      no_proxy: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
    });
  });

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
            claudeTemporaryParent: test.directory,
          },
          { runtime: "claude", launch: backendLaunch(), supervisor: supervisor(test.directory) },
        ),
      );
      expect(error.reason).toBe(reason);
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toHaveLength(
        remaining,
      );
      expect(yield* claudeTemporaryRoots(test.directory)).toEqual([]);
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
        claudeTemporaryParent: test.directory,
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
      expect(yield* claudeTemporaryRoots(test.directory)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("gives a Claude child a private temp root short enough for its sandboxed Bash", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const harness = yield* prepareLocalCliHarness(
        {
          agentDirectory: test.agentDirectory,
          environment: { ...test.environment, TMPDIR: SHARED_TEMPORARY_DIRECTORY },
        },
        { runtime: "claude", launch: backendLaunch(), supervisor: supervisor(test.directory) },
      );
      const temporary = harness.temporaryDirectory;
      const stat = yield* Effect.promise(() => fs.lstat(temporary));
      expect({
        directory: stat.isDirectory(),
        mode: stat.mode & 0o777,
        owned: yield* exists(nodePath.join(temporary, "owner.json")),
      }).toEqual({ directory: true, mode: 0o700, owned: true });
      expect(
        Buffer.byteLength(nodePath.join(temporary, `claude-${LARGEST_UID}`)),
      ).toBeLessThanOrEqual(CLAUDE_SHORT_TEMPORARY_BYTES);
      expect([
        harness.env.CLAUDE_CODE_TMPDIR,
        harness.env.TMPDIR,
        harness.env.TMP,
        harness.env.TEMP,
      ]).toEqual([temporary, temporary, temporary, temporary]);
      const settings = decodeClaudeSettings(
        yield* Effect.promise(() =>
          fs.readFile(nodePath.join(harness.directory, "settings.json"), "utf8"),
        ),
      );
      const sharedClaudeTemporary = nodePath.join(
        yield* Effect.promise(() => fs.realpath("/tmp")),
        `claude-${process.getuid?.() ?? ""}`,
      );
      expect(settings.sandbox.filesystem.denyWrite).toContain(sharedClaudeTemporary);

      yield* removeLocalCliHarness(harness);
      expect(yield* exists(temporary)).toBe(false);
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
    }),
  );

  it.live(
    "removes a Claude child's temp root with its process, even after the child locked it",
    () =>
      Effect.gen(function* () {
        const test = yield* setup;
        const service = makeLocalCliProcess({
          agentDirectory: test.agentDirectory,
          environment: test.environment,
          executables: { claude: executable, codex: executable },
          claudeTemporaryParent: test.directory,
        });
        yield* service
          .spawn({
            runtime: "claude",
            launch: backendLaunch(),
            supervisor: supervisor(test.directory),
          })
          .pipe(
            Effect.tap((child) => lockDirectoryTree(child.temporaryDirectory ?? "")),
            Effect.scoped,
          );
        expect(yield* claudeTemporaryRoots(test.directory)).toEqual([]);
        expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
      }),
  );

  it.live("points a Codex child's temp variables at a private directory its harness owns", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const harness = yield* prepareLocalCliHarness(
        { agentDirectory: test.agentDirectory, environment: codexEnvironment(test.environment) },
        {
          runtime: "codex",
          launch: backendLaunch({ writeIntent: "writer" }),
          supervisor: supervisor(test.directory),
        },
      );
      const temporary = harness.temporaryDirectory ?? "";
      const stat = yield* Effect.promise(() => fs.lstat(temporary));
      expect({ directory: stat.isDirectory(), mode: stat.mode & 0o777 }).toEqual({
        directory: true,
        mode: 0o700,
      });
      expect([harness.env.TMPDIR, harness.env.TMP, harness.env.TEMP]).toEqual([
        temporary,
        temporary,
        temporary,
      ]);
      yield* removeLocalCliHarness(harness);
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
    }),
  );

  it.live("removes the thread rollouts a Codex child persists in its private home", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const harness = yield* prepareLocalCliHarness(
        { agentDirectory: test.agentDirectory, environment: codexEnvironment(test.environment) },
        { runtime: "codex", launch: backendLaunch(), supervisor: supervisor(test.directory) },
      );
      const codexHome = harness.env.CODEX_HOME;
      if (codexHome === undefined) return yield* Effect.die("Codex needs a private home.");
      const rollouts = nodePath.join(codexHome, "sessions", "2026", "10", "15");
      const rollout = nodePath.join(rollouts, "rollout-thread.jsonl");
      yield* Effect.promise(() =>
        fs.mkdir(rollouts, { recursive: true }).then(() => fs.writeFile(rollout, "{}\n")),
      );
      yield* removeLocalCliHarness(harness);
      const remains = yield* Effect.promise(() =>
        fs.lstat(rollout).then(
          () => true,
          () => false,
        ),
      );
      expect(remains).toBe(false);
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
      return undefined;
    }),
  );

  it.live("removes a Codex child's temp directory even after the child locked part of it", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const service = makeLocalCliProcess({
        agentDirectory: test.agentDirectory,
        environment: codexEnvironment(test.environment),
        executables: { claude: executable, codex: executable },
      });
      yield* service
        .spawn({
          runtime: "codex",
          launch: backendLaunch(),
          supervisor: supervisor(test.directory),
        })
        .pipe(
          Effect.tap((child) => lockDirectoryTree(child.temporaryDirectory ?? "")),
          Effect.scoped,
        );
      expect(yield* Effect.promise(() => harnessEntries(test.agentDirectory))).toEqual([]);
    }),
  );

  it.live("releases the process before removing its scoped harness", () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const service = makeLocalCliProcess({
        agentDirectory: test.agentDirectory,
        environment: test.environment,
        executables: { claude: executable, codex: executable },
        claudeTemporaryParent: test.directory,
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
