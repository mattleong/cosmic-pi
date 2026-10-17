import { expect } from "vitest";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { io, workspaceTarget, workspaceTests, writeFile } from "./fixtures/repository.ts";

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  [".gitignore", "ignored.log\n"],
]);

test("reports no changes for an untouched worker, ignoring gitignored files", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "ignored.log"), "noise\n");
  expect(yield* service.inspectWorkerChanges(workspaceTarget(handle))).toEqual({
    changedPaths: [],
    uncapturedPaths: [],
  });
});

test("reports edited and new source files without freezing a revision", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  yield* writeFile(path.join(handle.cwd, "src/added.ts"), "added\n");
  const changes = yield* service.inspectWorkerChanges(workspaceTarget(handle));
  expect(changes.changedPaths.toSorted()).toEqual(["src/added.ts", "src/main.ts"]);
  expect(changes.uncapturedPaths).toEqual([]);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("active");
  expect(record.revision).toBeUndefined();
  // Inspection leaves the workspace free to freeze the same changes.
  const revision = yield* service.freeze(workspaceTarget(handle));
  expect(revision.changedPaths.toSorted()).toEqual(changes.changedPaths.toSorted());
});

test("reports a writer-created excluded file as uncaptured", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, ".env"), "TOKEN=local\n");
  expect(yield* service.inspectWorkerChanges(workspaceTarget(handle))).toEqual({
    changedPaths: [],
    uncapturedPaths: [".env"],
  });
});

test("reports dependencies a writer installed as uncaptured", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.mkdir(path.join(handle.cwd, "node_modules/left-pad"), { recursive: true }));
  yield* writeFile(
    path.join(handle.cwd, "node_modules/left-pad/index.js"),
    "module.exports = 1;\n",
  );
  const changes = yield* service.inspectWorkerChanges(workspaceTarget(handle));
  expect(changes.changedPaths).toEqual([]);
  expect(changes.uncapturedPaths).toEqual(["node_modules/left-pad/index.js"]);
});
