import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { CrossProcessLock } from "pi-cosmic-core";
import { git } from "../../src/boundary/git-worktree-process.ts";
import * as files from "../../src/boundary/git-worktree-publish.ts";
import * as commands from "../../src/boundary/workspace-setup.ts";
import {
  sourceLockNamespace,
  workspaceLockDirectory,
} from "../../src/boundary/git-worktree-store.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import type { WorkspaceError, WorkspaceHandle } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  exists,
  failureOf,
  fails,
  io,
  readText,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["other.txt", "other\n"],
  ["feature/deep/only.ts", "only\n"],
  ["shared/keep.ts", "keep\n"],
  ["shared/drop.ts", "drop\n"],
  ["dist/bundle.js", "bundle\n"],
]);

const registryOf = (agent: string) =>
  io(() => fs.realpath(agent)).pipe(Effect.map((root) => path.join(root, "git-workspaces")));

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
const blockingSetup = (started: string, release: string) => ({
  command: [
    "/bin/sh",
    "-c",
    'echo $$ > "$1.tmp" && mv "$1.tmp" "$1"; while [ ! -e "$2" ]; do sleep 0.05; done',
    "sh",
    started,
    release,
  ],
  timeoutSeconds: 60,
});

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Starts a blocking command, interrupts it once it runs, and returns the command's process ID and
// how many times the engine reported the quarantine cleared.
const interruptBlocked = (
  run: (
    command: ReturnType<typeof blockingSetup>,
    onQuarantineCleared: () => void,
  ) => Effect.Effect<unknown, WorkspaceError>,
) =>
  Effect.gen(function* () {
    const signals = yield* temporaryDirectory("pi-setup-signal-");
    const started = path.join(signals, "started");
    let cleared = 0;
    const running = yield* Effect.forkChild(
      run(blockingSetup(started, path.join(signals, "never")), () => {
        cleared += 1;
      }),
    );
    yield* waitFor(started);
    const pid = Number((yield* readText(started)).trim());
    yield* Fiber.interrupt(running);
    const exit = yield* Fiber.await(running);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    return { pid, cleared };
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

test("runs setup without holding the service permit or the checkout lock", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const signals = yield* temporaryDirectory("pi-setup-signal-");
  const started = path.join(signals, "started");
  const release = path.join(signals, "release");
  const running = yield* Effect.forkChild(
    service.setup({ ...workspaceTarget(handle), setup: blockingSetup(started, release) }),
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
  // The tree being set up stays out of reach meanwhile.
  expect((yield* failureOf(service.inspect(workspaceTarget(handle)))).message).toContain(
    "still running",
  );
  expect(yield* fails(service.discard(workspaceTarget(handle)))).toBe(true);
  expect(yield* fails(service.freeze(workspaceTarget(handle)))).toBe(true);
  yield* writeFile(release, "");
  yield* Fiber.join(running);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.setupCleanupPending).toBeUndefined();
  expect(yield* service.setupChanges(workspaceTarget(handle))).toEqual([]);
});

test("clears the marker once an interrupted setup's processes are confirmed stopped", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const { pid, cleared } = yield* interruptBlocked((setup, onQuarantineCleared) =>
    service.setup({ ...workspaceTarget(handle), setup, onQuarantineCleared }),
  );
  expect(processAlive(pid)).toBe(false);
  expect(cleared).toBe(1);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.setupCleanupPending).toBeUndefined();
  expect(record.status).toBe("active");
  // The workspace stays usable: setup runs again and the worker can be proposed.
  yield* service.setup({
    ...workspaceTarget(handle),
    setup: { command: ["/bin/sh", "-c", "true"] },
  });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* freezeAndPrepare(service, handle);
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("keeps a workspace quarantined when interrupted setup cleanup is unconfirmed", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  // The real command runs and stops, but its runner reports the process group unconfirmed.
  const original = commands.runWorkspaceSetup;
  const spy = vi
    .spyOn(commands, "runWorkspaceSetup")
    .mockImplementation((setup, cwd, options) =>
      original(setup, cwd, { ...options, onCleanup: () => options?.onCleanup?.(false) }),
    );
  const { cleared } = yield* interruptBlocked((setup, onQuarantineCleared) =>
    service.setup({ ...workspaceTarget(handle), setup, onQuarantineCleared }),
  ).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));
  expect(cleared).toBe(0);
  const failure = yield* failureOf(service.inspect(workspaceTarget(handle)));
  expect(failure.cleanupUnconfirmed).toBe(true);
  expect(failure.message).toContain("quarantined");
  expect(yield* fails(service.discard(workspaceTarget(handle)))).toBe(true);
  expect((yield* service.listAll).records[0]?.setupCleanupPending).toBe(handle.cwd);
});

test("withdraws a preparation whose setup was interrupted", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration } = yield* freezeAndPrepare(service, handle);
  const { cleared } = yield* interruptBlocked((setup, onQuarantineCleared) =>
    service.setup({
      ...workspaceTarget(handle),
      preparationId: prepared.preparationId,
      setup,
      onQuarantineCleared,
    }),
  );
  expect(cleared).toBe(1);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("frozen");
  expect(record.setupCleanupPending).toBeUndefined();
  expect(yield* exists(prepared.cwd)).toBe(false);
  expect(yield* fails(service.integrate(integration))).toBe(true);
});

const verifyIn = (
  service: WorkspaceServiceContract,
  handle: WorkspaceHandle,
  preparationId: string,
  script: string,
) =>
  service.verify({
    ...workspaceTarget(handle),
    preparationId,
    verify: { command: ["/bin/sh", "-c", script] },
  });

test("verifies a prepared tree, allowing only excluded outputs, and returns the output tail", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration } = yield* freezeAndPrepare(service, handle);
  const result = yield* verifyIn(
    service,
    handle,
    prepared.preparationId,
    'grep -q worker src/main.ts && mkdir -p coverage && echo report > coverage/out.txt && echo "12 passed"',
  );
  expect(result.outputTail).toContain("12 passed");
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("prepared");
  expect(record.setupCleanupPending).toBeUndefined();
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("keeps the preparation when verification fails, reporting its output", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration } = yield* freezeAndPrepare(service, handle);
  const failure = yield* failureOf(
    verifyIn(service, handle, prepared.preparationId, "echo 'FAIL main.test.ts' >&2; exit 1"),
  );
  expect(failure.message).toContain("code 1");
  expect(failure.cleanupUnconfirmed).not.toBe(true);
  expect(failure.detail).toContain("FAIL main.test.ts");
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("prepared");
  expect(record.preparation?.preparationId).toBe(prepared.preparationId);
  expect(yield* exists(prepared.cwd)).toBe(true);
  // The parent may still integrate the exact pair deliberately.
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("fails verification that changes a project file, naming it", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared } = yield* freezeAndPrepare(service, handle);
  const failure = yield* failureOf(
    verifyIn(service, handle, prepared.preparationId, "echo snapshot > other.txt; echo ran"),
  );
  expect(failure.message).toContain("other.txt");
  expect(failure.detail).toContain("ran");
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("prepared");
  expect(record.setupCleanupPending).toBeUndefined();
});

test("a verification command that can't start leaves no quarantine", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared } = yield* freezeAndPrepare(service, handle);
  let cleared = 0;
  const failure = yield* failureOf(
    service.verify({
      ...workspaceTarget(handle),
      preparationId: prepared.preparationId,
      verify: { command: ["pi-missing-verify-command"] },
      onQuarantineCleared: () => {
        cleared += 1;
      },
    }),
  );
  expect(failure.cleanupUnconfirmed).not.toBe(true);
  expect(cleared).toBe(1);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.setupCleanupPending).toBeUndefined();
  yield* service.discard(workspaceTarget(handle));
});

test("clears the marker once an interrupted verification is confirmed stopped", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration } = yield* freezeAndPrepare(service, handle);
  const { pid, cleared } = yield* interruptBlocked((verify, onQuarantineCleared) =>
    service.verify({
      ...workspaceTarget(handle),
      preparationId: prepared.preparationId,
      verify,
      onQuarantineCleared,
    }),
  );
  expect(processAlive(pid)).toBe(false);
  expect(cleared).toBe(1);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.setupCleanupPending).toBeUndefined();
  expect(record.status).toBe("prepared");
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("clears the marker after a worker setup fails with confirmed cleanup", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const failure = yield* failureOf(
    service.setup({ ...workspaceTarget(handle), setup: { command: ["/bin/sh", "-c", "exit 3"] } }),
  );
  expect(failure.cleanupUnconfirmed).not.toBe(true);
  expect(failure.message).toContain("code 3");
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("active");
  yield* service.discard(workspaceTarget(handle));
  expect(yield* exists(handle.cwd)).toBe(false);
});

test("withdraws a preparation whose setup failed so it can't be integrated", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { revision, prepared, integration } = yield* freezeAndPrepare(service, handle);
  expect(
    yield* fails(
      service.setup({
        ...workspaceTarget(handle),
        preparationId: prepared.preparationId,
        setup: { command: ["/bin/sh", "-c", "exit 4"] },
      }),
    ),
  ).toBe(true);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("frozen");
  expect(record.preparation).toBeUndefined();
  expect(yield* exists(prepared.cwd)).toBe(false);
  expect(yield* fails(service.integrate(integration))).toBe(true);
  expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
  // The reviewed revision can still be prepared again.
  const again = yield* service.prepare({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
  });
  yield* service.integrate({ ...integration, preparationId: again.preparationId });
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
});

test("removes the tree of a preparation that fails to apply", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const revision = yield* service.freeze(workspaceTarget(handle));
  yield* writeFile(path.join(root, "src/main.ts"), "conflicting parent edit\n");
  expect(
    yield* fails(service.prepare({ ...workspaceTarget(handle), revisionId: revision.revisionId })),
  ).toBe(true);
  const artifact = path.join(yield* registryOf(agent), handle.workspaceId);
  const names = yield* io(() => fs.readdir(artifact));
  expect(names.filter((name) => name.startsWith("prepare-"))).toEqual([]);
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
        String(to).endsWith("record.json") &&
        text.includes('"status":"creating"') &&
        !text.includes('"baseline":""')
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
  expect(names.filter((name) => /^[a-f0-9-]{36}$/u.test(name))).toEqual([]);
});

test("refuses an excluded session directory, naming it, and keeps nothing", function* (service, root) {
  const failure = yield* failureOf(
    service.create({ sourceCwd: path.join(root, "dist"), ownerId: "parent" }),
  );
  expect(failure.detail).toContain('"dist"');
  expect(failure.detail).toContain("Remedy:");
  yield* io(() => fs.mkdir(path.join(root, "empty")));
  const empty = yield* failureOf(
    service.create({ sourceCwd: path.join(root, "empty"), ownerId: "parent" }),
  );
  expect(empty.detail).toContain('"empty"');
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
});

test("removes directories that deleting their last file left empty", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.unlink(path.join(handle.cwd, "feature/deep/only.ts")));
  yield* io(() => fs.unlink(path.join(handle.cwd, "shared/drop.ts")));
  const { integration } = yield* freezeAndPrepare(service, handle);
  const integrated = yield* service.integrate(integration);
  expect(integrated.remainingBackupPaths).toEqual([]);
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

test("leaves journal evidence when the index changes during publication", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* freezeAndPrepare(service, handle);
  const original = files.publishWorkspaceFile;
  const spy = vi
    .spyOn(files, "publishWorkspaceFile")
    .mockImplementation((request) =>
      original(request).pipe(Effect.tap(() => git(root, ["add", "--", "src/main.ts"]))),
    );
  const failure = yield* failureOf(service.integrate(integration)).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(failure.message).toContain("mid-integration");
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("integrating");
  const backup = record.journal?.[0]?.backupPath ?? "";
  expect(failure.detail).toContain(backup);
  expect(yield* readText(root, backup)).toBe("baseline\n");
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  const registry = yield* registryOf(agent);
  expect(failure.detail).toContain(path.join(registry, handle.workspaceId, "record.json"));
});

test("caches the publication helper only in a private registry directory", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* freezeAndPrepare(service, handle);
  yield* service.integrate(integration);
  const cache = path.join(yield* registryOf(agent), "publication-cache");
  expect((yield* io(() => fs.lstat(cache))).mode & 0o777).toBe(0o700);
  expect((yield* io(() => fs.readdir(cache))).length).toBeGreaterThan(0);
  expect(yield* service.listAll).toMatchObject({ unavailable: [] });
});
