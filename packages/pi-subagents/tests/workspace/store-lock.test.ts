import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { CrossProcessLock, crossProcessLockHolder } from "pi-cosmic-core";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import {
  sourceLockNamespace,
  withWorkspaceStoreLock,
  workspaceLockDirectory,
} from "../../src/boundary/git-worktree-store.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import { nodeSpawn } from "../support/node-builtins.ts";
import { waitForDead } from "../support/process-liveness.ts";
import {
  commitRepository,
  failureOf,
  io,
  temporaryDirectory,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const lockFor = (directory: string) =>
  CrossProcessLock.use((lock) => Effect.succeed(lock)).pipe(
    Effect.provide(CrossProcessLock.layer({ directory })),
  );

it.effect("waits for another session's operation on the same checkout, then runs", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* temporaryDirectory("workspace-lock-"), "locks");
    const locks = yield* lockFor(directory);
    const held = yield* locks.tryAcquire(sourceLockNamespace("/repo"));
    const other = yield* withWorkspaceStoreLock(
      locks,
      directory,
      "/other",
      Effect.succeed("other"),
    );
    expect(other).toBe("other");
    const waiting = yield* withWorkspaceStoreLock(
      locks,
      directory,
      "/repo",
      Effect.succeed("ran"),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust("1 minute");
    expect(waiting.pollUnsafe()).toBeUndefined();
    held?.release();
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(waiting)).toBe("ran");
  }).pipe(Effect.scoped),
);

it.effect("gives up after a bounded wait, naming the lock and its owner", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* temporaryDirectory("workspace-lock-"), "locks");
    const locks = yield* lockFor(directory);
    const held = yield* locks.tryAcquire(sourceLockNamespace("/repo"));
    const waiting = yield* withWorkspaceStoreLock(locks, directory, "/repo", Effect.void).pipe(
      Effect.flip,
      Effect.forkChild,
    );
    yield* TestClock.adjust("3 minutes");
    const failure = yield* Fiber.join(waiting);
    const { slot } = crossProcessLockHolder(sourceLockNamespace("/repo"), { directory });
    expect(failure.detail).toContain(slot);
    expect(failure.detail).toContain(`process ${process.pid}`);
    held?.release();
  }).pipe(Effect.scoped),
);

it.effect("stops waiting when interrupted", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* temporaryDirectory("workspace-lock-"), "locks");
    const locks = yield* lockFor(directory);
    const held = yield* locks.tryAcquire(sourceLockNamespace("/repo"));
    const waiting = yield* withWorkspaceStoreLock(locks, directory, "/repo", Effect.void).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("1 second");
    yield* Fiber.interrupt(waiting);
    expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
    held?.release();
    expect(yield* locks.tryAcquire(sourceLockNamespace("/repo"))).toBeDefined();
  }).pipe(Effect.scoped),
);

const exitedProcessId = Effect.gen(function* () {
  const child = nodeSpawn("/usr/bin/true", [], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  yield* Effect.promise(() => new Promise((resolve) => child.once("exit", resolve)));
  yield* waitForDead(pid);
  return pid;
});

const test = workspaceTests([["src/main.ts", "baseline\n"]]);

test("reclaims a lock left by a process that exited and ignores the old global lock", function* (service, root, agent) {
  const registry = path.join(agent, "git-workspaces");
  const directory = workspaceLockDirectory(registry);
  yield* io(() => fs.mkdir(path.join(registry, "operation.lock"), { recursive: true }));
  yield* io(() => fs.chmod(registry, 0o700));
  yield* io(() => fs.mkdir(directory, { mode: 0o700 }));
  const { slot } = crossProcessLockHolder(sourceLockNamespace(root), { directory });
  yield* io(() => fs.mkdir(slot, { mode: 0o700 }));
  const owner = {
    version: 1,
    token: "a".repeat(64),
    pid: yield* exitedProcessId,
    phase: "quiescent",
  };
  yield* io(() =>
    fs.writeFile(path.join(slot, "owner.json"), JSON.stringify(owner), { mode: 0o600 }),
  );
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(handle.cwd.startsWith(registry)).toBe(true);
});

it.live(
  "keeps the agent directory usable through a symlinked path but refuses links below it",
  () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("pi-agent-link-");
      const source = path.join(temporary, "source");
      yield* commitRepository(source, [["main.ts", "baseline\n"]]);
      const real = path.join(temporary, "real-agent");
      yield* io(() => fs.mkdir(real, { mode: 0o700 }));
      const alias = path.join(temporary, "alias");
      yield* io(() => fs.symlink(temporary, alias));
      const linked = path.join(alias, "real-agent");
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const handle = yield* service.create({ sourceCwd: source, ownerId: "parent" });
        expect(handle.cwd.startsWith(path.join(real, "git-workspaces"))).toBe(true);
        expect(yield* service.list({ ownerId: "parent" })).toHaveLength(1);
      }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: linked })));

      const redirected = path.join(temporary, "redirected-agent");
      yield* io(() => fs.mkdir(redirected, { mode: 0o700 }));
      yield* io(() => fs.mkdir(path.join(temporary, "elsewhere"), { mode: 0o700 }));
      yield* io(() =>
        fs.symlink(path.join(temporary, "elsewhere"), path.join(redirected, "git-workspaces")),
      );
      yield* writeFile(path.join(temporary, "elsewhere", "marker"), "outside\n");
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const failure = yield* failureOf(service.create({ sourceCwd: source, ownerId: "parent" }));
        expect(failure.operation).toBe("registry");
        expect(yield* io(() => fs.readdir(path.join(temporary, "elsewhere")))).toEqual(["marker"]);
      }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: redirected })));
    }),
  60_000,
);
