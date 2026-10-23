import { assert, expect } from "vitest";
import { nodeFsPromises as fs, nodePath as path } from "../support/node-builtins.ts";
import { git } from "../../src/boundary/git-worktree-process.ts";
import {
  exists,
  io,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

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
    diffStat: [],
  });
});

test("reports edited and new source files without freezing a revision", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  yield* writeFile(path.join(handle.cwd, "src/added.ts"), "added\n");
  const changes = yield* service.inspectWorkerChanges(workspaceTarget(handle));
  expect(Arr.sort(changes.changedPaths, Order.String)).toEqual(["src/added.ts", "src/main.ts"]);
  expect(changes.uncapturedPaths).toEqual([]);
  expect(changes.diffStat).toEqual([
    { path: "src/added.ts", change: "added", binary: false, addedLines: 1, deletedLines: 0 },
    { path: "src/main.ts", change: "modified", binary: false, addedLines: 1, deletedLines: 1 },
  ]);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("active");
  expect(record.revision).toBeUndefined();
  // Inspection leaves the workspace free to freeze the same changes.
  const revision = yield* service.freeze(workspaceTarget(handle));
  expect(Arr.sort(revision.changedPaths, Order.String)).toEqual(
    Arr.sort(changes.changedPaths, Order.String),
  );
});

const CREDENTIAL_FILES = [
  ".env",
  ".npmrc",
  "certs/server.pem",
  "config/credentials.json",
  "deploy/id_rsa",
  "secrets.txt",
];
const CREDENTIAL_NAMED_SOURCES = ["src/auth/credentials.ts", "src/secrets.ts"];

test("leaves writer-created credential files out, keeping credential-named source", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  for (const name of [...CREDENTIAL_FILES, ...CREDENTIAL_NAMED_SOURCES]) {
    yield* io(() => fs.mkdir(path.dirname(path.join(handle.cwd, name)), { recursive: true }));
    yield* writeFile(path.join(handle.cwd, name), `${name}\n`);
  }
  const changes = yield* service.inspectWorkerChanges(workspaceTarget(handle));
  expect(Arr.sort(changes.changedPaths, Order.String)).toEqual(CREDENTIAL_NAMED_SOURCES);
  expect(Arr.sort(changes.uncapturedPaths, Order.String)).toEqual(
    Arr.sort(CREDENTIAL_FILES, Order.String),
  );
  // They never block: the revision prepares and integrates without them.
  const revision = yield* service.freeze(workspaceTarget(handle));
  expect(Arr.sort(revision.changedPaths, Order.String)).toEqual(CREDENTIAL_NAMED_SOURCES);
  assert(revision.uncapturedPaths !== undefined);
  expect(Arr.sort(revision.uncapturedPaths, Order.String)).toEqual(
    Arr.sort(CREDENTIAL_FILES, Order.String),
  );
  const prepared = yield* service.prepare({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
  });
  yield* service.integrate({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    preparationId: prepared.preparationId,
  });
  for (const name of CREDENTIAL_NAMED_SOURCES)
    expect(yield* readText(root, name)).toBe(`${name}\n`);
  for (const name of CREDENTIAL_FILES) expect(yield* exists(path.join(root, name))).toBe(false);
});

test("keeps capturing a credential-named file the baseline tracks", function* (service, root) {
  yield* writeFile(path.join(root, ".npmrc"), "registry=https://example.invalid\n");
  yield* git(root, ["add", "--", ".npmrc"]);
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, ".npmrc"), "registry=https://changed.invalid\n");
  expect(yield* service.inspectWorkerChanges(workspaceTarget(handle))).toMatchObject({
    changedPaths: [".npmrc"],
    uncapturedPaths: [],
  });
});

test("ignores dependencies a writer installed in an ignored directory", function* (service, root) {
  yield* writeFile(path.join(root, ".gitignore"), "ignored.log\nnode_modules/\n");
  yield* git(root, ["add", "--", ".gitignore"]);
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.mkdir(path.join(handle.cwd, "node_modules/left-pad"), { recursive: true }));
  yield* writeFile(
    path.join(handle.cwd, "node_modules/left-pad/index.js"),
    "module.exports = 1;\n",
  );
  expect(yield* service.inspectWorkerChanges(workspaceTarget(handle))).toEqual({
    changedPaths: [],
    uncapturedPaths: [],
    diffStat: [],
  });
});

test("counts binary, deleted, and mode-only changes", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "image.bin"), new Uint8Array([0, 1, 2, 3]));
  yield* io(() => fs.chmod(path.join(handle.cwd, "src/main.ts"), 0o755));
  yield* io(() => fs.unlink(path.join(handle.cwd, ".gitignore")));
  const changes = yield* service.inspectWorkerChanges(workspaceTarget(handle));
  expect(changes.diffStat).toEqual([
    { path: ".gitignore", change: "deleted", binary: false, addedLines: 0, deletedLines: 1 },
    { path: "image.bin", change: "added", binary: true, addedLines: 0, deletedLines: 0 },
    {
      path: "src/main.ts",
      change: "modified",
      binary: false,
      addedLines: 0,
      deletedLines: 0,
      modeChange: { from: "100644", to: "100755" },
    },
  ]);
});
