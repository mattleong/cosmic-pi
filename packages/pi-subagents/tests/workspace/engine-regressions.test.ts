import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { CrossProcessLock } from "pi-cosmic-core";
import { git } from "../../src/boundary/git-worktree-process.ts";
import {
  sourceLockNamespace,
  workspaceLockDirectory,
} from "../../src/boundary/git-worktree-store.ts";
import { nodeFsPromises as fs, nodePath as path } from "../support/node-builtins.ts";
import type { WorkspaceError, WorkspaceHandle } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import { capturedWarnings, unconfirmedShellCleanup } from "../support/unconfirmed-hook-cleanup.ts";
import {
  exists,
  failureOf,
  fails,
  io,
  readText,
  registryOf as registryPath,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["other.txt", "other\n"],
  ["feature/deep/only.ts", "only\n"],
  ["shared/keep.ts", "keep\n"],
  ["shared/drop.ts", "drop\n"],
  ["dist/bundle.js", "bundle\n"],
  [".gitignore", "coverage/\nscratch/\n"],
]);

const registryOf = (agent: string) => io(() => fs.realpath(agent)).pipe(Effect.map(registryPath));

const waitFor = (file: string, attempts = 400): Effect.Effect<void, WorkspaceError> =>
  exists(file).pipe(
    Effect.flatMap((found) => {
      if (found) return Effect.void;
      if (attempts === 0) return Effect.die(new Error(`Timed out waiting for ${file}`));
      return Effect.sleep("25 millis").pipe(Effect.andThen(waitFor(file, attempts - 1)));
    }),
  );

// Writes its process ID to `started`, then blocks until `release` exists, without touching the tree
// it runs in.
const blockingHook = (started: string, release: string) => ({
  command: [
    "/bin/sh",
    "-c",
    'echo $$ > "$1.tmp" && mv "$1.tmp" "$1"; while [ ! -e "$2" ]; do sleep 0.05; done',
    "sh",
    started,
    release,
  ],
  timeout: 60,
});

const shellHook = (script: string, ...args: ReadonlyArray<string>) => ({
  command: ["/bin/sh", "-c", script, "sh", ...args],
});

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Starts a blocking hook, interrupts it once it runs, and returns the hook's process ID.
const interruptBlocked = (
  run: (hook: ReturnType<typeof blockingHook>) => Effect.Effect<unknown, WorkspaceError>,
) =>
  Effect.gen(function* () {
    const signals = yield* temporaryDirectory("pi-hook-signal-");
    const started = path.join(signals, "started");
    const running = yield* Effect.forkChild(
      run(blockingHook(started, path.join(signals, "never"))),
    );
    yield* waitFor(started);
    const pid = Number(Str.trim(yield* readText(started)));
    yield* Fiber.interrupt(running);
    const exit = yield* Fiber.await(running);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    return { pid };
  });

const freezeAndPrepare = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    return {
      revision,
      prepared,
      integration: {
        ...workspaceTarget(handle),
        revisionId: revision.revisionId,
        preparationId: prepared.preparationId,
      },
    };
  });

test("runs WorktreeCreate hooks in order in worker and prepared trees with the event on stdin", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const hooks = [
    shellHook("mkdir -p scratch && cat > scratch/first.json"),
    shellHook("test -e scratch/first.json && cat > scratch/second.json"),
  ];
  yield* service.runCreateHooks({ ...workspaceTarget(handle), hooks, runId: "run-1" });
  expect(JSON.parse(yield* readText(handle.cwd, "scratch/second.json"))).toEqual({
    event: "WorktreeCreate",
    workspaceId: handle.workspaceId,
    worktreePath: handle.cwd,
    sourceCwd: root,
    kind: "worker",
    runId: "run-1",
  });
  expect(yield* service.hookChanges(workspaceTarget(handle))).toEqual([]);

  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration } = yield* freezeAndPrepare(service, handle);
  yield* service.runCreateHooks({
    ...workspaceTarget(handle),
    preparationId: prepared.preparationId,
    hooks,
  });
  expect(JSON.parse(yield* readText(prepared.cwd, "scratch/first.json"))).toEqual({
    event: "WorktreeCreate",
    workspaceId: handle.workspaceId,
    worktreePath: prepared.cwd,
    sourceCwd: root,
    kind: "prepare",
  });
  expect(
    yield* service.hookChanges({
      ...workspaceTarget(handle),
      preparationId: prepared.preparationId,
    }),
  ).toEqual([]);
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("stops at the first failing WorktreeCreate hook and reports project files hooks changed", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const signals = yield* temporaryDirectory("pi-hook-signal-");
  const failure = yield* failureOf(
    service.runCreateHooks({
      ...workspaceTarget(handle),
      hooks: [shellHook("exit 3"), shellHook('touch "$1/second-ran"', signals)],
    }),
  );
  expect(failure.cleanupUnconfirmed).not.toBe(true);
  expect(yield* exists(path.join(signals, "second-ran"))).toBe(false);

  yield* service.runCreateHooks({
    ...workspaceTarget(handle),
    hooks: [shellHook("echo changed > other.txt")],
  });
  expect(yield* service.hookChanges(workspaceTarget(handle))).toEqual(["other.txt"]);
});

test("keeps a preparation whose WorktreeCreate hook exited 0 with its cleanup unconfirmed", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration } = yield* freezeAndPrepare(service, handle);
  const { workspaceIds, layer } = capturedWarnings();
  const spy = unconfirmedShellCleanup();
  yield* service
    .runCreateHooks({
      ...workspaceTarget(handle),
      preparationId: prepared.preparationId,
      hooks: [shellHook("exit 0")],
    })
    .pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => spy.mockRestore())));
  expect(workspaceIds).toEqual([handle.workspaceId]);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("prepared");
  expect(record.preparation?.preparationId).toBe(prepared.preparationId);
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("runs WorktreeCreate hooks without holding the service permit or the checkout lock", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const signals = yield* temporaryDirectory("pi-hook-signal-");
  const started = path.join(signals, "started");
  const release = path.join(signals, "release");
  const running = yield* Effect.forkChild(
    service.runCreateHooks({ ...workspaceTarget(handle), hooks: [blockingHook(started, release)] }),
  );
  yield* waitFor(started);
  // Another Pi process could take the checkout lock, and this session keeps working.
  const registry = yield* registryOf(agent);
  const lease = yield* CrossProcessLock.use((locks) =>
    locks.tryAcquire(sourceLockNamespace(root)),
  ).pipe(Effect.provide(CrossProcessLock.layer({ directory: workspaceLockDirectory(registry) })));
  expect(lease).toBeDefined();
  lease?.release();
  expect((yield* service.listAll).records).toHaveLength(1);
  const other = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* service.discard(workspaceTarget(other));
  yield* writeFile(release, "");
  yield* Fiber.join(running);
  expect(yield* service.hookChanges(workspaceTarget(handle))).toEqual([]);
});

test("kills interrupted WorktreeCreate hooks and leaves the workspace usable", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const { pid } = yield* interruptBlocked((hook) =>
    service.runCreateHooks({ ...workspaceTarget(handle), hooks: [hook] }),
  );
  expect(processAlive(pid)).toBe(false);
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("active");
  yield* service.runCreateHooks({ ...workspaceTarget(handle), hooks: [shellHook("true")] });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* freezeAndPrepare(service, handle);
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("removes the tree of a preparation that fails to apply", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const revision = yield* service.freeze(workspaceTarget(handle));
  yield* writeFile(path.join(root, "src/main.ts"), "conflicting parent edit\n");
  const conflict = yield* failureOf(
    service.prepare({ ...workspaceTarget(handle), revisionId: revision.revisionId }),
  );
  expect(conflict.code).toBe("workspace_conflict");
  expect(conflict.detail).toContain('"src/main.ts"');
  const artifact = path.join(yield* registryOf(agent), handle.workspaceId);
  const names = yield* io(() => fs.readdir(artifact));
  expect(Arr.filter(names, (name) => Fn.pipe(name, Str.startsWith("prepare-")))).toEqual([]);
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("frozen");
});

interface PendingInterrupt {
  current?: () => void;
}

test("removes what an interrupted create made before acquiring the workspace", function* (service, root, agent) {
  const rename = fs.rename;
  const pending: PendingInterrupt = {};
  // The second creating save names the baseline; interrupt just before the worker tree is added.
  const spy = vi.spyOn(fs, "rename").mockImplementation((from, to) =>
    fs.readFile(from, "utf8").then((text) => {
      if (
        Fn.pipe(String(to), Str.endsWith("record.json")) &&
        Fn.pipe(text, Str.includes('"status":"creating"')) &&
        !Fn.pipe(text, Str.includes('"baseline":""'))
      )
        pending.current?.();
      return rename(from, to);
    }),
  );
  const launch = yield* Effect.forkChild(service.create({ sourceCwd: root, ownerId: "parent" }));
  pending.current = () => launch.interruptUnsafe();
  const exit = yield* Fiber.await(launch).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(Exit.hasInterrupts(exit)).toBe(true);
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
  const registry = yield* registryOf(agent);
  const names = yield* io(() => fs.readdir(registry));
  expect(Arr.filter(names, (name) => /^[a-f0-9-]{36}$/u.test(name))).toEqual([]);
  expect(yield* git(root, ["worktree", "list", "--porcelain"])).not.toContain(registry);
  expect(yield* git(root, ["for-each-ref", "refs/pi"])).toBe("");
});

test("refuses a session directory the worker wouldn't hold, naming it, and keeps nothing", function* (service, root) {
  yield* io(() => fs.mkdir(path.join(root, "scratch")));
  yield* writeFile(path.join(root, "scratch/notes.txt"), "ignored\n");
  yield* io(() => fs.mkdir(path.join(root, "empty")));
  for (const name of ["scratch", "empty"]) {
    const refused = yield* failureOf(
      service.create({ sourceCwd: path.join(root, name), ownerId: "parent" }),
    );
    expect(refused.detail).toContain(`"${name}"`);
    expect(refused.detail).toContain("Remedy:");
  }
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
  expect(yield* git(root, ["worktree", "list", "--porcelain"])).not.toContain("subagent-worktrees");
  expect(yield* git(root, ["for-each-ref", "refs/pi"])).toBe("");
});

test("removes directories that deleting their last file left empty", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.unlink(path.join(handle.cwd, "feature/deep/only.ts")));
  yield* io(() => fs.unlink(path.join(handle.cwd, "shared/drop.ts")));
  const { integration } = yield* freezeAndPrepare(service, handle);
  yield* service.integrate(integration);
  expect(yield* exists(path.join(root, "feature"))).toBe(false);
  expect(yield* io(() => fs.readdir(path.join(root, "shared")))).toEqual(["keep.ts"]);
  expect(yield* exists(path.join(root, "src/main.ts"))).toBe(true);
});

test("refuses integration after a staged-only source change", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* freezeAndPrepare(service, handle);
  // The working tree matches the tested parent again; only the index differs.
  yield* writeFile(path.join(root, "other.txt"), "staged\n");
  yield* git(root, ["add", "--", "other.txt"]);
  yield* writeFile(path.join(root, "other.txt"), "other\n");
  expect(yield* fails(service.integrate(integration))).toBe(true);
  expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("prepared");
});
