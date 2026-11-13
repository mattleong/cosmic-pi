import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";
import * as gitProcess from "../../src/boundary/git-worktree-process.ts";
import { nodeFsPromises as fs, nodePath as path } from "../support/node-builtins.ts";
import type { WorkspaceHandle, WorkspaceRecord } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  exists,
  failureOf,
  io,
  preparedTrees,
  prepareIntegration,
  readText,
  registryOf,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const test = workspaceTests([
  ["src/a.ts", "a\nb\nc\n"],
  ["src/b.ts", "one\n"],
  ["src/gone.ts", "gone\n"],
]);

const editWorker = (handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nworker\nc\n");
    yield* writeFile(path.join(handle.cwd, "src/new.ts"), "new\n");
    yield* io(() => fs.unlink(path.join(handle.cwd, "src/gone.ts")));
  });

test("rebases onto current parent files, keeping conflict markers for the writer", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const target = workspaceTarget(handle);
  yield* editWorker(handle);
  const frozen = yield* service.freeze(target);
  yield* service.prepare({ ...target, revisionId: frozen.revisionId });
  yield* writeFile(path.join(root, "src/a.ts"), "a\nparent\nc\n");
  yield* writeFile(path.join(root, "src/b.ts"), "parent b\n");
  const rebased = yield* service.rebase(target);
  expect(rebased).toEqual({
    reappliedPaths: ["src/a.ts", "src/gone.ts", "src/new.ts"],
    conflictedPaths: ["src/a.ts"],
  });
  const conflicted = yield* readText(handle.cwd, "src/a.ts");
  expect(conflicted).toContain("<<<<<<<");
  expect(conflicted).toContain("parent");
  expect(conflicted).toContain("worker");
  expect(yield* readText(handle.cwd, "src/b.ts")).toBe("parent b\n");
  expect(yield* readText(handle.cwd, "src/new.ts")).toBe("new\n");
  expect(yield* exists(path.join(handle.cwd, "src/gone.ts"))).toBe(false);
  const record = yield* service.inspect(target);
  expect(record.status).toBe("active");
  expect(record.revision).toBeUndefined();
  expect(yield* preparedTrees(path.dirname(handle.cwd))).toEqual([]);
  // Hooks in the rebuilt tree are judged against it, not against the new baseline.
  expect(yield* service.hookChanges(target)).toEqual([]);
  yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nparent and worker\nc\n");
  const { revision, integration } = yield* prepareIntegration(service, handle);
  expect(revision.changedPaths).toEqual(["src/a.ts", "src/gone.ts", "src/new.ts"]);
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/a.ts")).toBe("a\nparent and worker\nc\n");
  expect(yield* readText(root, "src/b.ts")).toBe("parent b\n");
});

test("refuses a rebase the three-way merge can't run, leaving the worker and record unchanged", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const target = workspaceTarget(handle);
  yield* writeFile(path.join(handle.cwd, "src/gone.ts"), "worker kept it\n");
  yield* writeFile(path.join(handle.cwd, "src/new.ts"), "new\n");
  const revision = yield* service.freeze(target);
  yield* io(() => fs.unlink(path.join(root, "src/gone.ts")));
  const failure = yield* failureOf(service.rebase(target));
  expect(failure.code).toBe("workspace_rebase_refused");
  expect(yield* readText(handle.cwd, "src/gone.ts")).toBe("worker kept it\n");
  expect(yield* readText(handle.cwd, "src/new.ts")).toBe("new\n");
  const record = yield* service.inspect(target);
  expect(record.status).toBe("frozen");
  expect(record.revision?.revisionId).toBe(revision.revisionId);
  expect(yield* preparedTrees(path.dirname(handle.cwd))).toEqual([]);
});

const artifactOf = (agent: string, handle: WorkspaceHandle) =>
  path.join(registryOf(agent), handle.workspaceId);

/** Runs `effect` while `spy` is installed, restoring it however `effect` ends. */
const spied = <A, E, R>(spy: { mockRestore: () => void }, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));

const ioFailure = () => Promise.reject(Object.assign(new Error("injected"), { code: "EIO" }));

interface RecordSaves {
  /** Whether the record being renamed into place is the one this save targets. */
  readonly matches: (text: string) => boolean;
  /** Fail the rename itself, so record.json keeps its previous content. */
  readonly failRename?: boolean;
  /** Fail the next sync of the workspace directory after the rename, as a lost fsync would. */
  readonly failSync?: boolean;
  /** Fail later renames of records this matches. */
  readonly failLaterRenames?: (text: string) => boolean;
}

/** Injects record.json save failures through the filesystem calls saveWorkspaceRecord makes. */
const failRecordSave = (artifact: string, saves: RecordSaves) => {
  const rename = fs.rename;
  const open = fs.open;
  let syncFailurePending = false;
  let matched = false;
  const renameSpy = vi.spyOn(fs, "rename").mockImplementation((from, to) =>
    fs.readFile(from, "utf8").then((text) => {
      if (String(to) === path.join(artifact, "record.json")) {
        if (matched && saves.failLaterRenames?.(text)) return ioFailure();
        if (!matched && saves.matches(text)) {
          matched = true;
          if (saves.failRename) return ioFailure();
          if (saves.failSync) syncFailurePending = true;
        }
      }
      return rename(from, to);
    }),
  );
  const openSpy = vi.spyOn(fs, "open").mockImplementation((file, flags, mode) => {
    if (syncFailurePending && String(file) === artifact && flags === "r") {
      syncFailurePending = false;
      return ioFailure();
    }
    return open(file, flags, mode);
  });
  return {
    mockRestore: () => {
      renameSpy.mockRestore();
      openSpy.mockRestore();
    },
  };
};

const isRebuilt = (text: string) => Fn.pipe(text, Str.includes('"rebasedTree"'));

// The worker has frozen changes, and the parent then changes a file the worker left alone.
const rebaseScenario = (service: WorkspaceServiceContract, root: string) =>
  Effect.gen(function* () {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* editWorker(handle);
    const revision = yield* service.freeze(workspaceTarget(handle));
    yield* writeFile(path.join(root, "src/b.ts"), "parent b\n");
    const before = unstamped(yield* service.inspect(workspaceTarget(handle)));
    return { handle, revision, before };
  });

// Putting a record back saves it again, which stamps a new change time.
const unstamped = ({ lastChangedAt: _changed, ...record }: WorkspaceRecord) => record;

const expectWorkerRestored = (handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    expect(yield* readText(handle.cwd, "src/a.ts")).toBe("a\nworker\nc\n");
    expect(yield* readText(handle.cwd, "src/new.ts")).toBe("new\n");
    expect(yield* readText(handle.cwd, "src/b.ts")).toBe("one\n");
    expect(yield* exists(path.join(handle.cwd, "src/gone.ts"))).toBe(false);
  });

test("restores the worker when saving the rebuilt record fails past the trial", function* (service, root, agent) {
  const { handle, revision, before } = yield* rebaseScenario(service, root);
  yield* spied(
    failRecordSave(artifactOf(agent, handle), { matches: isRebuilt, failRename: true }),
    failureOf(service.rebase(workspaceTarget(handle))),
  );
  yield* expectWorkerRestored(handle);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(unstamped(record)).toEqual(before);
  expect(record.revision?.revisionId).toBe(revision.revisionId);
});

test("puts the previous record back before restoring when the rebuilt one landed but its sync failed", function* (service, root, agent) {
  const { handle, before } = yield* rebaseScenario(service, root);
  const failure = yield* spied(
    failRecordSave(artifactOf(agent, handle), { matches: isRebuilt, failSync: true }),
    failureOf(service.rebase(workspaceTarget(handle))),
  );
  expect(failure.operation).toBe("registry");
  yield* expectWorkerRestored(handle);
  expect(unstamped(yield* service.inspect(workspaceTarget(handle)))).toEqual(before);
});

test("keeps the rebuilt worker when its record landed and the previous one can't be put back", function* (service, root, agent) {
  const { handle, before } = yield* rebaseScenario(service, root);
  yield* spied(
    failRecordSave(artifactOf(agent, handle), {
      matches: isRebuilt,
      failSync: true,
      failLaterRenames: (text) => !isRebuilt(text),
    }),
    failureOf(service.rebase(workspaceTarget(handle))),
  );
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("active");
  expect(record.baseline).not.toBe(before.baseline);
  // The worker matches the record that names it, so the next freeze keeps the parent's edit.
  expect(yield* readText(handle.cwd, "src/b.ts")).toBe("parent b\n");
  expect(yield* readText(handle.cwd, "src/a.ts")).toBe("a\nworker\nc\n");
  const revision = yield* service.freeze(workspaceTarget(handle));
  expect(revision.changedPaths).toEqual(["src/a.ts", "src/gone.ts", "src/new.ts"]);
});

test("names the rebase-worker ref when restoring the worker fails, and it holds the worker's files", function* (service, root, agent) {
  const { handle } = yield* rebaseScenario(service, root);
  const artifact = artifactOf(agent, handle);
  const original = gitProcess.git;
  let resets = 0;
  const gitSpy = vi.spyOn(gitProcess, "git").mockImplementation((cwd, args, options) => {
    if (cwd === handle.cwd && args[0] === "read-tree" && args[1] === "--reset") {
      resets += 1;
      // The first moves the worker to its captured files; the second would restore it.
      if (resets === 2) return Effect.fail(gitProcess.workspaceFailure("git", "injected"));
    }
    return original(cwd, args, options);
  });
  const failure = yield* spied(
    gitSpy,
    spied(
      failRecordSave(artifact, { matches: isRebuilt, failRename: true }),
      failureOf(service.rebase(workspaceTarget(handle))),
    ),
  );
  expect(resets).toBe(2);
  const ref = `refs/pi/workspaces/${handle.workspaceId}/rebase-worker`;
  expect(failure.detail).toContain(ref);
  expect(yield* gitProcess.git(root, ["show", `${ref}:src/a.ts`])).toBe("a\nworker\nc\n");
  expect(yield* gitProcess.git(root, ["show", `${ref}:src/new.ts`])).toBe("new\n");
});
