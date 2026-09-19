import * as Effect from "effect/Effect";
import type { WorkspaceRecord } from "../workspace/model.ts";
import { nodeFsPromises as fs, nodePath as path } from "./node-builtins.ts";
import { checkDirectory, workspaceFailure, workspaceIO } from "./git-worktree-process.ts";
import {
  createWorkspaceDirectory,
  publishWorkspaceFile,
  type WorkspacePublicationRequest,
} from "./git-worktree-publish.ts";
import {
  bytesEqual,
  readWorkspaceFile,
  type SnapshotEntry,
  type WorkspaceSnapshot,
} from "./git-worktree-snapshot.ts";
import { newWorkspaceId, saveWorkspaceRecord } from "./git-worktree-store.ts";

const directoryIdentity = (directory: string) =>
  Effect.gen(function* () {
    yield* checkDirectory(directory);
    const stat = yield* workspaceIO("integrate", () => fs.lstat(directory));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return yield* workspaceFailure("integrate", "Publication directory changed.");
    return { directoryDev: stat.dev, directoryIno: stat.ino };
  });
const checkPreimage = (root: string, name: string, expected: SnapshotEntry | undefined) =>
  Effect.gen(function* () {
    const visible = yield* readWorkspaceFile(root, name);
    if (
      !visible !== !expected ||
      (visible &&
        expected &&
        (visible.mode !== expected.mode ||
          visible.permissions !== expected.permissions ||
          !bytesEqual(visible.bytes, expected.bytes)))
    )
      return yield* workspaceFailure(
        "integrate",
        "Source preimage changed; publication stopped and recovery artifacts retained.",
      );
  });

/** Caller holds every prepared source writer lease through helper cleanup. */
export const publishWorkspace = (
  registry: string,
  record: WorkspaceRecord,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
) =>
  Effect.gen(function* () {
    const previous = new Map(before.entries.map((entry) => [entry.path, entry]));
    const next = new Map(after.entries.map((entry) => [entry.path, entry]));
    const changed = [...new Set([...previous.keys(), ...next.keys()])]
      .filter((name) => {
        const a = previous.get(name),
          b = next.get(name);
        return a?.oid !== b?.oid || a?.mode !== b?.mode;
      })
      .sort();
    if (
      changed.some(
        (name) => previous.get(name)?.mode === "120000" || next.get(name)?.mode === "120000",
      )
    )
      return yield* workspaceFailure(
        "integrate",
        "Symlink changes cannot be published; source files were not modified.",
      );
    const permissions = (name: string) => {
      const expected = previous.get(name),
        content = next.get(name);
      if (!expected) return content?.mode === "100755" ? 0o755 : 0o644;
      if (expected.mode === content?.mode) return expected.permissions;
      return (expected.permissions & ~0o111) | (content?.mode === "100755" ? 0o111 : 0);
    };
    const root = record.handle.sourceRoot;
    const directories = new Map([[root, yield* directoryIdentity(root)]]);
    const missingDirectories = new Set<string>();
    for (const name of changed) {
      yield* checkDirectory(path.dirname(path.join(root, name)), true);
      let parent = path.dirname(name);
      while (parent !== ".") {
        const full = path.join(root, parent);
        const exists = yield* workspaceIO("integrate", () =>
          fs.lstat(full).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          ),
        );
        if (!exists) missingDirectories.add(parent);
        else {
          if (!record.preparation!.leaseDirectories.includes(full))
            return yield* workspaceFailure(
              "integrate",
              "Changed-file ancestors changed; prepare and test again before integration.",
            );
          if (!directories.has(full)) directories.set(full, yield* directoryIdentity(full));
        }
        parent = path.dirname(parent);
      }
      yield* checkPreimage(root, name, previous.get(name));
    }
    const plannedDirectories = [...missingDirectories].sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );
    const entries = yield* Effect.forEach(changed, (name) =>
      Effect.gen(function* () {
        const token = yield* newWorkspaceId();
        return {
          path: name,
          temporaryPath: path.join(path.dirname(name), `.pi-workspace-new-${token}`),
          backupPath: path.join(path.dirname(name), `.pi-workspace-old-${token}`),
          before: previous.get(name)
            ? {
                oid: previous.get(name)!.oid,
                mode: previous.get(name)!.mode,
                permissions: previous.get(name)!.permissions,
              }
            : undefined,
          after: next.get(name)
            ? {
                oid: next.get(name)!.oid,
                mode: next.get(name)!.mode,
                permissions: permissions(name),
              }
            : undefined,
        };
      }),
    );
    // Predetermined names and pinned/fsynced before/after Git blobs precede all source
    // mutation. Interrupted helper calls retain this journal and never auto-retry.
    let journal: WorkspaceRecord = {
      ...record,
      status: "integrating",
      publishedCount: 0,
      plannedDirectories,
      createdDirectoryCount: 0,
      journal: entries,
    };
    yield* saveWorkspaceRecord(registry, journal);
    for (const name of plannedDirectories) {
      const target = path.join(root, name),
        parent = path.dirname(target);
      const identity = directories.get(parent);
      if (!identity)
        return yield* workspaceFailure("integrate", "Missing parent directory ownership.");
      const created = yield* createWorkspaceDirectory({
        directory: parent,
        ...identity,
        name: path.basename(target),
      });
      directories.set(target, created);
      journal = { ...journal, createdDirectoryCount: (journal.createdDirectoryCount ?? 0) + 1 };
      yield* saveWorkspaceRecord(registry, journal);
    }
    for (const entry of entries) {
      const directory = path.dirname(path.join(root, entry.path));
      const identity = directories.get(directory);
      if (!identity)
        return yield* workspaceFailure("integrate", "Missing publication directory ownership.");
      const expected = previous.get(entry.path),
        content = next.get(entry.path);
      let request: WorkspacePublicationRequest = {
        directory,
        ...identity,
        name: path.basename(entry.path),
        temporaryName: path.basename(entry.temporaryPath),
        backupName: path.basename(entry.backupPath),
      };
      if (expected)
        request = { ...request, before: { bytes: expected.bytes, mode: expected.permissions } };
      if (content)
        request = { ...request, after: { bytes: content.bytes, mode: permissions(entry.path) } };
      const result = yield* publishWorkspaceFile(request);
      if (result.status !== "success")
        return yield* workspaceFailure(
          "integrate",
          "Publication conflict or uncertainty; inspect the retained journal, captured backup and temporary file. No automatic rollback occurred.",
        );
      journal = { ...journal, publishedCount: (journal.publishedCount ?? 0) + 1 };
      yield* saveWorkspaceRecord(registry, journal);
    }
    return journal;
  });
