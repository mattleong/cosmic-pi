import * as Effect from "effect/Effect";
import { expect, vi } from "vitest";
import * as files from "../../src/boundary/git-worktree-publish.ts";
import * as gitProcess from "../../src/boundary/git-worktree-process.ts";
import * as store from "../../src/boundary/git-worktree-store.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import type { WorkspaceHandle, WorkspaceRecord } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  exists,
  failureOf,
  io,
  readText,
  registryOf,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const test = workspaceTests([
  ["src/a.ts", "a\nb\nc\n"],
  ["src/b.ts", "one\n"],
  ["src/gone.ts", "gone\n"],
]);

const artifactOf = (agent: string, handle: WorkspaceHandle) =>
  path.join(registryOf(agent), handle.workspaceId);

const editWorker = (handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nworker\nc\n");
    yield* writeFile(path.join(handle.cwd, "src/new.ts"), "new\n");
    yield* io(() => fs.unlink(path.join(handle.cwd, "src/gone.ts")));
  });

const publicationArtifacts = (root: string) =>
  io(() => fs.readdir(root, { recursive: true })).pipe(
    Effect.map((names) =>
      names.filter((name) => path.basename(name).startsWith(".pi-workspace-")).toSorted(),
    ),
  );

const freezeAndPrepare = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const target = workspaceTarget(handle);
    const revision = yield* service.freeze(target);
    const prepared = yield* service.prepare({ ...target, revisionId: revision.revisionId });
    return {
      revision,
      integration: {
        ...target,
        revisionId: revision.revisionId,
        preparationId: prepared.preparationId,
      },
    };
  });

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

const isRebuilt = (text: string) => text.includes('"rebasedTree"');

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

const isIntegrated = (text: string) => text.includes('"status":"integrated"');

test("keeps an integration mid-integration, its backups tracked, when its record can't be saved", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* editWorker(handle);
  const { integration } = yield* freezeAndPrepare(service, handle);
  const failure = yield* spied(
    failRecordSave(artifactOf(agent, handle), { matches: isIntegrated, failRename: true }),
    failureOf(service.integrate(integration)),
  );
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("integrating");
  const backups = (record.journal ?? []).flatMap((entry) =>
    entry.before ? [entry.backupPath] : [],
  );
  expect(backups.toSorted()).toEqual(yield* publicationArtifacts(root));
  for (const backup of backups) expect(failure.detail).toContain(backup);
  yield* service.discard(workspaceTarget(handle));
  expect(yield* readText(root, "src/a.ts")).toBe("a\nb\nc\n");
  expect(yield* readText(root, "src/gone.ts")).toBe("gone\n");
  expect(yield* exists(path.join(root, "src/new.ts"))).toBe(false);
  expect(yield* publicationArtifacts(root)).toEqual([]);
});

test("completes an integration whose record landed though its directory sync failed", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* editWorker(handle);
  const { integration } = yield* freezeAndPrepare(service, handle);
  const integrated = yield* spied(
    failRecordSave(artifactOf(agent, handle), { matches: isIntegrated, failSync: true }),
    service.integrate(integration),
  );
  expect(integrated.remainingBackupPaths).toEqual([]);
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("integrated");
  expect(yield* publicationArtifacts(root)).toEqual([]);
  expect(yield* readText(root, "src/a.ts")).toBe("a\nworker\nc\n");
  expect(yield* readText(root, "src/new.ts")).toBe("new\n");
});

test("discard drops a backup reservation left by a stop before the file moved there", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nworker\nc\n");
  const { integration } = yield* freezeAndPrepare(service, handle);
  const rename = fs.rename;
  const spy = vi
    .spyOn(fs, "rename")
    .mockImplementation((from, to) =>
      path.basename(String(to)).startsWith(files.publicationBackupPrefix)
        ? ioFailure()
        : rename(from, to),
    );
  yield* spied(spy, failureOf(service.integrate(integration)));
  const reservation = (yield* publicationArtifacts(root)).find((name) =>
    path.basename(name).startsWith(files.publicationBackupPrefix),
  );
  expect(reservation).toBeDefined();
  expect((yield* io(() => fs.stat(path.join(root, reservation ?? "")))).size).toBe(0);
  yield* service.discard(workspaceTarget(handle));
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("discarded");
  expect(yield* readText(root, "src/a.ts")).toBe("a\nb\nc\n");
  expect(yield* publicationArtifacts(root)).toEqual([]);
});

test("resets leftover publication progress before saving a new publication's journal", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* editWorker(handle);
  const { integration } = yield* freezeAndPrepare(service, handle);
  const progress = path.join(artifactOf(agent, handle), "publication.json");
  // An earlier publication's progress whose best-effort removal failed.
  yield* writeFile(progress, JSON.stringify({ directories: 2, files: 3 }));
  const original = store.savePublicationProgress;
  const spy = vi
    .spyOn(store, "savePublicationProgress")
    .mockImplementation((registry, id, saved) =>
      saved.files > 0
        ? Effect.fail(gitProcess.workspaceFailure("registry", "injected"))
        : original(registry, id, saved),
    );
  yield* spied(spy, failureOf(service.integrate(integration)));
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("integrating");
  expect(JSON.parse(yield* readText(progress))).toEqual({ directories: 0, files: 0 });
  yield* service.discard(workspaceTarget(handle));
  expect(yield* readText(root, "src/a.ts")).toBe("a\nb\nc\n");
  expect(yield* exists(path.join(root, "src/new.ts"))).toBe(false);
});
