import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { nodeFsPromises as fs, nodePath as path } from "../support/node-builtins.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
import {
  exists,
  failureOf,
  io,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

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
  expect(
    (yield* io(() => fs.readdir(path.dirname(handle.cwd)))).filter((name) =>
      name.startsWith("prepare-"),
    ),
  ).toEqual([]);
  // Hooks in the rebuilt tree are judged against it, not against the new baseline.
  expect(yield* service.hookChanges(target)).toEqual([]);
  yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nparent and worker\nc\n");
  const revision = yield* service.freeze(target);
  expect(revision.changedPaths).toEqual(["src/a.ts", "src/gone.ts", "src/new.ts"]);
  const prepared = yield* service.prepare({ ...target, revisionId: revision.revisionId });
  yield* service.integrate({
    ...target,
    revisionId: revision.revisionId,
    preparationId: prepared.preparationId,
  });
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
  const workspaceDirectory = path.dirname(handle.cwd);
  expect(
    (yield* io(() => fs.readdir(workspaceDirectory))).filter((name) => name.startsWith("prepare-")),
  ).toEqual([]);
});
