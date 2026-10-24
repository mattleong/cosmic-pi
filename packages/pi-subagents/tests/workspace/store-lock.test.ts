import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as TestClock from "effect/testing/TestClock";
import { CrossProcessLock, crossProcessLockHolder } from "pi-cosmic-core";
import { nodeFsPromises as fs, nodePath as path, nodeSpawn } from "../support/node-builtins.ts";
import {
  sourceLockNamespace,
  withWorkspaceStoreLock,
  workspaceLockDirectory,
} from "../../src/boundary/git-worktree-store.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import { waitForDead } from "../support/process-liveness.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

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

it.effect("gives up with a lock failure once the wait runs out", () =>
  Effect.gen(function* () {
    const directory = path.join(yield* temporaryDirectory("workspace-lock-"), "locks");
    const locks = yield* lockFor(directory);
    const held = yield* locks.tryAcquire(sourceLockNamespace("/repo"));
    let ran = false;
    const waiting = yield* withWorkspaceStoreLock(
      locks,
      directory,
      "/repo",
      Effect.sync(() => {
        ran = true;
      }),
    ).pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("2 minutes");
    yield* TestClock.adjust("1 second");
    const failure = yield* Fiber.join(waiting);
    expect(failure.operation).toBe("lock");
    expect(ran).toBe(false);
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

const livePause = TestClock.withLive(Effect.sleep("5 millis"));

const untilExists = (file: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if (yield* exists(file)) return undefined;
      yield* livePause;
    }
    return yield* Effect.die(new Error(`${file} never appeared.`));
  });

/** Joins `fiber`, advancing the test clock in small steps so its process sweeps can finish. */
const joinAdvancing = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    while (fiber.pollUnsafe() === undefined) {
      yield* TestClock.adjust("10 millis");
      yield* livePause;
    }
    return yield* Fiber.join(fiber);
  });

it.effect(
  "queues a create behind the session's own long discard instead of timing out on the lock",
  () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("workspace-queue-");
      const root = path.join(temporary, "source");
      const agent = path.join(temporary, "agent");
      const entered = path.join(temporary, "entered");
      const release = path.join(temporary, "release");
      yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
      yield* TestClock.withLive(commitRepository(root, [["src/main.ts", "baseline\n"]]));
      // The discard holds the checkout's store lock while this hook waits to be released.
      const hold = {
        command: [
          "/bin/sh",
          "-c",
          'touch "$1"; while [ ! -e "$2" ]; do sleep 0.02; done',
          "sh",
          entered,
          release,
        ],
        timeout: 3_600,
      };
      // Everything but the queued create runs on the live clock.
      const context = yield* TestClock.withLive(
        Layer.build(WorkspaceService.layer({ agentDirectory: agent, worktreeRemove: [hold] })),
      );
      const service = Context.get(context, WorkspaceService);
      const first = yield* TestClock.withLive(
        service.create({ sourceCwd: root, ownerId: "parent" }),
      );
      const discarding = yield* TestClock.withLive(service.discard(workspaceTarget(first))).pipe(
        Effect.forkChild,
      );
      yield* untilExists(entered);
      const creating = yield* service
        .create({ sourceCwd: root, ownerId: "parent" })
        .pipe(Effect.forkChild);
      // Well past the store lock's two-minute wait.
      for (let step = 0; step < 30; step++) {
        yield* TestClock.adjust("5 seconds");
        yield* livePause;
      }
      expect(creating.pollUnsafe()).toBeUndefined();
      yield* writeFile(release, "");
      yield* Fiber.join(discarding);
      const second = yield* joinAdvancing(creating);
      expect(second.workspaceId).not.toBe(first.workspaceId);
    }).pipe(Effect.scoped),
  60_000,
);

const exitedProcessId = Effect.gen(function* () {
  const child = nodeSpawn("/usr/bin/true", [], { stdio: "ignore" });
  const pid = child.pid ?? 0;
  yield* Effect.callback<void>((resume) => {
    child.once("exit", () => resume(Effect.void));
  });
  yield* waitForDead(pid);
  return pid;
});

const test = workspaceTests([["src/main.ts", "baseline\n"]]);

test("reclaims a lock left by a process that exited and ignores the old global lock", function* (service, root, agent) {
  const registry = path.join(agent, "subagent-worktrees");
  const directory = workspaceLockDirectory(registry);
  yield* io(() => fs.mkdir(path.join(registry, "operation.lock"), { recursive: true }));
  yield* io(() => fs.chmod(registry, 0o700));
  yield* io(() => fs.mkdir(directory, { mode: 0o700 }));
  const { slot } = crossProcessLockHolder(sourceLockNamespace(root), { directory });
  yield* io(() => fs.mkdir(slot, { mode: 0o700 }));
  const owner = {
    version: 1,
    token: Fn.pipe("a", Str.repeat(64)),
    pid: yield* exitedProcessId,
    phase: "quiescent",
  };
  yield* io(() =>
    fs.writeFile(path.join(slot, "owner.json"), JSON.stringify(owner), { mode: 0o600 }),
  );
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(Fn.pipe(handle.cwd, Str.startsWith(registry))).toBe(true);
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
        expect(Fn.pipe(handle.cwd, Str.startsWith(path.join(real, "subagent-worktrees")))).toBe(
          true,
        );
        expect(yield* service.list({ ownerId: "parent" })).toHaveLength(1);
      }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: linked })));

      const redirected = path.join(temporary, "redirected-agent");
      yield* io(() => fs.mkdir(redirected, { mode: 0o700 }));
      yield* io(() => fs.mkdir(path.join(temporary, "elsewhere"), { mode: 0o700 }));
      yield* io(() =>
        fs.symlink(path.join(temporary, "elsewhere"), path.join(redirected, "subagent-worktrees")),
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
