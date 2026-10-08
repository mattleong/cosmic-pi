import { expect } from "vitest";
import * as Effect from "effect/Effect";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import type { WorkspaceError, WorkspaceHandle } from "../../src/workspace/model.ts";
import { exists, failureOf, io, workspaceTarget, workspaceTests } from "./fixtures/repository.ts";

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["other.txt", "other\n"],
  [".gitignore", "ignored.ts\n"],
]);

/** Runs the discard of a worker found unchanged, as the workspace's coordinator does. */
const confirmed = (discard: Effect.Effect<void, WorkspaceError>) => discard.pipe(Effect.as(true));

/** What a writer did in its worker tree. */
type WriterChange = (cwd: string) => Promise<void>;

/** A fresh worker after `change`, which a writer made in its tree. */
const workerAfter = (root: string, change: WriterChange) =>
  Effect.gen(function* () {
    const service = yield* WorkspaceService;
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* io(() => change(handle.cwd));
    return handle;
  });

/** Expects the worker to be kept as it was: an active record and its tree on disk. */
const expectKept = (handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const service = yield* WorkspaceService;
    expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("active");
    expect(yield* exists(path.join(handle.cwd, "src/main.ts"))).toBe(true);
  });

test("discards a worker that holds nothing beyond its baseline", function* (service, root) {
  // An empty directory holds no work: no revision could carry it.
  const handle = yield* workerAfter(root, (cwd) =>
    fs.mkdir(path.join(cwd, "scratch")).then(() => undefined),
  );
  expect(yield* service.discardUnchanged(workspaceTarget(handle), confirmed)).toBe(true);
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("discarded");
  expect(yield* exists(handle.cwd)).toBe(false);
});

test("keeps an unchanged worker whose discard its coordinator declines", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(
    yield* service.discardUnchanged(workspaceTarget(handle), () => Effect.succeed(false)),
  ).toBe(false);
  yield* expectKept(handle);
});

const changes: ReadonlyArray<readonly [string, WriterChange]> = [
  ["a modified file", (cwd) => fs.writeFile(path.join(cwd, "src/main.ts"), "changed\n")],
  ["a deleted file", (cwd) => fs.rm(path.join(cwd, "other.txt"))],
  ["an untracked file", (cwd) => fs.writeFile(path.join(cwd, "src/new.ts"), "new\n")],
  ["an ignored file", (cwd) => fs.writeFile(path.join(cwd, "ignored.ts"), "output\n")],
  ["a file the snapshot leaves out", (cwd) => fs.writeFile(path.join(cwd, "notes.bin"), "x")],
  [
    "a file in an excluded directory",
    (cwd) =>
      fs
        .mkdir(path.join(cwd, "node_modules/pkg"), { recursive: true })
        .then(() => fs.writeFile(path.join(cwd, "node_modules/pkg/index.js"), "x\n")),
  ],
];

for (const [name, change] of changes)
  test(`keeps a worker with ${name}`, function* (service, root) {
    const handle = yield* workerAfter(root, change);
    expect(yield* service.discardUnchanged(workspaceTarget(handle), confirmed)).toBe(false);
    yield* expectKept(handle);
  });

test("keeps a worker whose check fails", function* (service, root) {
  // Hardlinks are unsupported, so the snapshot of this worker fails.
  const handle = yield* workerAfter(root, (cwd) =>
    fs.link(path.join(cwd, "other.txt"), path.join(cwd, "src/alias.ts")),
  );
  yield* failureOf(service.discardUnchanged(workspaceTarget(handle), confirmed));
  yield* expectKept(handle);
});

test("never discards a worker that was frozen for review", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* service.freeze(workspaceTarget(handle));
  expect(yield* service.discardUnchanged(workspaceTarget(handle), confirmed)).toBe(false);
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("frozen");
});
