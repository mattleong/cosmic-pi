import { expect, vi } from "vitest";
import * as publication from "../../src/boundary/git-worktree-integration.ts";
import * as files from "../../src/boundary/git-worktree-publish.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { git } from "../../src/boundary/git-worktree-process.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../src/workspace/service.ts";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import { type WorkspaceHandle } from "../../src/workspace/model.ts";
import {
  exists,
  failureOf,
  fails,
  io,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const test = workspaceTests(
  [
    ["src/main.ts", "baseline\n"],
    ["other.txt", "other\n"],
    ["binary.dat", new Uint8Array([0, 255, 13, 10])],
    [".env", "SECRET=never-copy-this-head-value\n"],
    [".gitignore", "ignored.ts\n"],
  ],
  [".env"],
);
const prepareIntegration = (handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const service = yield* WorkspaceService;
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    const integration = {
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    };
    return { revision, prepared, integration };
  });

test("rejects an unleased ancestor appearing between lease revalidation and publication discovery", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.mkdir(path.join(handle.cwd, "feature")));
  yield* writeFile(path.join(handle.cwd, "feature/new.ts"), "new\n");
  const { integration } = yield* prepareIntegration(handle);
  const leases = yield* WriterLeaseService.pipe(
    Effect.provide(WriterLeaseService.layer({ agentDirectory: agent })),
  );
  const ancestor = path.join(root, "feature");
  const original = publication.publishWorkspace;
  let acquired = false;
  const spy = vi.spyOn(publication, "publishWorkspace").mockImplementation((...args) =>
    Effect.gen(function* () {
      yield* io(() => fs.mkdir(ancestor));
      const cwd = yield* leases.canonicalize(ancestor).pipe(Effect.orDie);
      return yield* Effect.acquireUseRelease(
        leases.acquire({ cwd, runId: "gap-writer" }).pipe(Effect.orDie),
        () =>
          Effect.gen(function* () {
            acquired = true;
            return yield* original(...args);
          }),
        (lease) => leases.release(lease).pipe(Effect.orDie),
      );
    }),
  );
  const failure = yield* failureOf(service.integrate(integration)).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(acquired).toBe(true);
  expect(failure.message).toContain("ancestors changed");
  expect(yield* io(() => fs.readdir(ancestor))).toEqual([]);
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("prepared");
});

interface PendingInterrupt {
  current?: () => void;
}

test("reports and owns a create interrupted while it commits the active record", function* (service, root) {
  const reported: WorkspaceHandle[] = [];
  const rename = fs.rename;
  const pendingInterrupt: PendingInterrupt = {};
  const spy = vi.spyOn(fs, "rename").mockImplementation((from, to) =>
    fs.readFile(from, "utf8").then((text) => {
      if (String(to).endsWith("record.json") && text.includes('"status":"active"'))
        pendingInterrupt.current?.();
      return rename(from, to);
    }),
  );
  const launch = yield* Effect.forkChild(
    service.create({ sourceCwd: root, ownerId: "parent", onAcquired: (h) => reported.push(h) }),
  );
  pendingInterrupt.current = () => launch.interruptUnsafe();
  const exit = yield* Fiber.await(launch).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(Exit.hasInterrupts(exit)).toBe(true);
  expect(reported).toHaveLength(1);
  yield* service.discard(workspaceTarget(reported[0]!));
  expect(yield* exists(reported[0]!.cwd)).toBe(false);
});

const addInternalAliases = (root: string) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(root, "AGENTS.md"), "original instructions\n");
    yield* io(() => fs.symlink("AGENTS.md", path.join(root, "CLAUDE.md")));
    yield* io(() => fs.symlink("../AGENTS.md", path.join(root, "src/alias.md")));
    yield* git(root, ["add", "--", "AGENTS.md", "CLAUDE.md", "src/alias.md"]);
  });

for (const change of ["remove", "retarget", "regular", "add"] as const) {
  test(`rejects worker symlink ${change} without publishing earlier regular-file edits`, function* (service, root) {
    yield* addInternalAliases(root);
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(handle.cwd, "AGENTS.md"), "must not publish\n");
    if (change === "add") {
      yield* io(() => fs.symlink("AGENTS.md", path.join(handle.cwd, "extra.md")));
      yield* git(handle.cwd, ["add", "--", "extra.md"]);
    } else {
      yield* io(() => fs.unlink(path.join(handle.cwd, "CLAUDE.md")));
      if (change === "retarget")
        yield* io(() => fs.symlink("other.txt", path.join(handle.cwd, "CLAUDE.md")));
      if (change === "regular")
        yield* writeFile(path.join(handle.cwd, "CLAUDE.md"), "regular now\n");
    }
    expect(yield* fails(service.freeze(workspaceTarget(handle)))).toBe(true);
    expect(yield* readText(root, "AGENTS.md")).toBe("original instructions\n");
    expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("active");
  });
}

test("snapshots current edits without HEAD secrets and publishes binary/mode/deletes without staging", function* (service, root) {
  yield* writeFile(path.join(root, "src/main.ts"), "staged\n");
  yield* git(root, ["add", "--", "src/main.ts"]);
  yield* writeFile(path.join(root, "src/main.ts"), "current\n");
  yield* writeFile(path.join(root, "src/new.ts"), "untracked source\n");
  yield* writeFile(path.join(root, "ignored.ts"), "ignored\n");
  const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
  const head = yield* git(root, ["rev-parse", "HEAD"]);
  const handle = yield* service.create({
    sourceCwd: path.join(root, "src"),
    ownerId: "parent",
  });
  expect(handle.cwd).not.toContain(root);
  expect(path.basename(handle.cwd)).toBe("src");
  expect(yield* readText(handle.cwd, "main.ts")).toBe("current\n");
  expect(yield* readText(handle.cwd, "new.ts")).toBe("untracked source\n");
  const worker = path.dirname(handle.cwd);
  expect(yield* exists(path.join(worker, ".env"))).toBe(false);
  expect(yield* exists(path.join(worker, "ignored.ts"))).toBe(false);
  yield* writeFile(path.join(handle.cwd, "main.ts"), "worker\n");
  yield* writeFile(path.join(worker, "binary.dat"), new Uint8Array([0, 250, 1, 2]));
  yield* io(() => fs.chmod(path.join(handle.cwd, "main.ts"), 0o755));
  yield* io(() => fs.unlink(path.join(worker, "other.txt")));
  yield* io(() => fs.mkdir(path.join(worker, "feature/nested"), { recursive: true }));
  yield* writeFile(path.join(worker, "feature/nested/new.ts"), "new nested source\n");
  const {
    revision: review,
    prepared: preparation,
    integration,
  } = yield* prepareIntegration(handle);
  expect(review.changedPaths).toContain("binary.dat");
  expect(yield* readText(preparation.cwd, "main.ts")).toBe("worker\n");
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  expect(yield* readText(root, "feature/nested/new.ts")).toBe("new nested source\n");
  expect(preparation.leaseDirectories).toEqual([root, path.join(root, "src")]);
  expect(yield* io(() => fs.readFile(path.join(root, "binary.dat")))).toEqual(
    Buffer.from([0, 250, 1, 2]),
  );
  expect((yield* io(() => fs.stat(path.join(root, "src/main.ts")))).mode & 0o111).not.toBe(0);
  expect(yield* exists(path.join(root, "other.txt"))).toBe(false);
  expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
  expect(yield* git(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(yield* readText(root, ".env")).toBe("SECRET=never-copy-this-head-value\n");
});

const publicationArtifacts = (root: string) =>
  io(() => fs.readdir(root, { recursive: true })).pipe(
    Effect.map((names) =>
      names.filter((name) => path.basename(name).startsWith(".pi-workspace-")).toSorted(),
    ),
  );

// Publication stops at src/main.ts because an editor saved it after the preimage check, so
// other.txt is already published with its original in a backup.
const originalPublish = files.publishWorkspaceFile;
const stopPublicationAtMain = (
  service: WorkspaceServiceContract,
  handle: WorkspaceHandle,
  root: string,
) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(handle.cwd, "other.txt"), "published first\n");
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "never published\n");
    const { integration } = yield* prepareIntegration(handle);
    const spy = vi.spyOn(files, "publishWorkspaceFile").mockImplementation((request, hooks) =>
      Effect.gen(function* () {
        if (request.name === "main.ts")
          yield* writeFile(path.join(request.directory, request.name), "editor save\n");
        return yield* originalPublish(request, hooks);
      }).pipe(Effect.orDie),
    );
    yield* failureOf(service.integrate(integration)).pipe(
      Effect.ensuring(Effect.sync(() => spy.mockRestore())),
    );
    expect(yield* readText(root, "other.txt")).toBe("published first\n");
    expect(yield* readText(root, "src/main.ts")).toBe("editor save\n");
  });

test("discard rolls back a publication that stopped partway", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* stopPublicationAtMain(service, handle, root);
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("integrating");
  // The conflicting file was put back as it was found, so only the published file's backup remains.
  expect(yield* publicationArtifacts(root)).toEqual([record.journal?.[0]?.backupPath]);
  expect((yield* io(() => fs.stat(path.join(root, "src/main.ts")))).nlink).toBe(1);
  yield* service.discard(workspaceTarget(handle));
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("discarded");
  expect(yield* readText(root, "other.txt")).toBe("other\n");
  expect(yield* readText(root, "src/main.ts")).toBe("editor save\n");
  expect(yield* publicationArtifacts(root)).toEqual([]);
  expect(yield* exists(handle.cwd)).toBe(false);
});

test("refuses rollback while a published file has changed since, then completes it", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* stopPublicationAtMain(service, handle, root);
  yield* writeFile(path.join(root, "other.txt"), "edited after publication\n");
  const refused = yield* failureOf(service.discard(workspaceTarget(handle)));
  expect(refused.code).toBe("workspace_rollback_refused");
  expect(refused.detail).toContain('"other.txt"');
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("integrating");
  expect(yield* readText(root, "other.txt")).toBe("edited after publication\n");
  expect(yield* publicationArtifacts(root)).toHaveLength(1);
  yield* writeFile(path.join(root, "other.txt"), "published first\n");
  yield* service.discard(workspaceTarget(handle));
  expect(yield* readText(root, "other.txt")).toBe("other\n");
  expect(yield* publicationArtifacts(root)).toEqual([]);
});

test("rollback removes created files and the directories made for them", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.mkdir(path.join(handle.cwd, "feature/deep"), { recursive: true }));
  yield* writeFile(path.join(handle.cwd, "feature/deep/new.ts"), "new\n");
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* prepareIntegration(handle);
  const spy = vi
    .spyOn(files, "publishWorkspaceFile")
    .mockImplementation((request, hooks) =>
      request.name === "main.ts"
        ? Effect.succeed({ status: "uncertain", reason: "io-failure" })
        : originalPublish(request, hooks),
    );
  yield* failureOf(service.integrate(integration)).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(yield* readText(root, "feature/deep/new.ts")).toBe("new\n");
  yield* service.discard(workspaceTarget(handle));
  expect(yield* exists(path.join(root, "feature"))).toBe(false);
  expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
});

test("keeps a frozen revision's patch out of its record and reads it back", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker change\n");
  const { revision, integration } = yield* prepareIntegration(handle);
  expect(revision.diff).toContain("+worker change");
  const record = yield* readText(agent, "subagent-worktrees", handle.workspaceId, "record.json");
  expect(record).not.toContain("worker change");
  expect(yield* service.revision(workspaceTarget(handle))).toEqual(revision);
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker change\n");
});

test("binds acceptance to unchanged worker, tested tree and source preimages", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration: request } = yield* prepareIntegration(handle);
  yield* writeFile(path.join(prepared.cwd, "other.txt"), "test rewrote source\n");
  expect(yield* fails(service.integrate(request))).toBe(true);
  yield* writeFile(path.join(prepared.cwd, "other.txt"), "other\n");
  yield* writeFile(path.join(handle.cwd, "other.txt"), "late worker\n");
  expect(yield* fails(service.integrate(request))).toBe(true);
  yield* writeFile(path.join(handle.cwd, "other.txt"), "other\n");
  yield* writeFile(path.join(root, "src/main.ts"), "late parent\n");
  const touched = yield* failureOf(service.integrate(request));
  expect(touched.code).toBe("workspace_parent_changed");
  expect(touched.detail).toContain('"src/main.ts"');
  expect(yield* readText(root, "src/main.ts")).toBe("late parent\n");
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("prepared");
});

test("keeps parent edits to files the proposal doesn't touch, naming them", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* prepareIntegration(handle);
  yield* writeFile(path.join(root, "other.txt"), "late parent\n");
  yield* writeFile(path.join(root, "src/late.ts"), "new parent file\n");
  const integrated = yield* service.integrate(integration);
  expect(integrated.untouchedDriftPaths).toEqual(["other.txt", "src/late.ts"]);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  expect(yield* readText(root, "other.txt")).toBe("late parent\n");
  expect(yield* readText(root, "src/late.ts")).toBe("new parent file\n");
});

test("carries every new worker file, whatever its name or extension", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const created = [
    "src/Billing/Invoice.cs",
    "assets/icon.svg",
    "src/__snapshots__/main.test.ts.snap",
    "src/auth/credentials.ts",
  ];
  for (const name of created) {
    yield* io(() => fs.mkdir(path.dirname(path.join(handle.cwd, name)), { recursive: true }));
    yield* writeFile(path.join(handle.cwd, name), `${name}\n`);
  }
  yield* writeFile(path.join(handle.cwd, "ignored.ts"), "output\n");
  const { revision, prepared, integration } = yield* prepareIntegration(handle);
  expect(revision.changedPaths.toSorted()).toEqual(created.toSorted());
  expect(revision.uncapturedPaths).toBeUndefined();
  const integrated = yield* service.integrate(integration);
  for (const name of created) expect(yield* readText(root, name)).toBe(`${name}\n`);
  expect(yield* exists(path.join(root, "ignored.ts"))).toBe(false);
  expect(yield* exists(integrated.workerRoot)).toBe(false);
  expect(yield* exists(prepared.cwd)).toBe(false);
});

test("carries worker files Git can name, such as one starting with a dash", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "-draft.ts"), "draft\n");
  yield* writeFile(path.join(handle.cwd, "notes: today.md"), "notes\n");
  const { revision, integration } = yield* prepareIntegration(handle);
  expect(revision.changedPaths).toEqual(["-draft.ts", "notes: today.md"]);
  expect(revision.uncapturedPaths).toBeUndefined();
  yield* service.integrate(integration);
  expect(yield* readText(root, "-draft.ts")).toBe("draft\n");
  expect(yield* readText(root, "notes: today.md")).toBe("notes\n");
});

test("leaves ignored dependencies out and carries unignored ones like any other file", function* (service, root) {
  yield* writeFile(path.join(root, ".gitignore"), "ignored.ts\nnode_modules/\n");
  yield* git(root, ["add", "--", ".gitignore"]);
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  for (const directory of ["vendor", "node_modules/left-pad"])
    yield* io(() => fs.mkdir(path.join(handle.cwd, directory), { recursive: true }));
  yield* writeFile(path.join(handle.cwd, "vendor/lib.js"), "vendored\n");
  yield* writeFile(path.join(handle.cwd, "node_modules/left-pad/index.js"), "pad\n");
  const { revision, integration } = yield* prepareIntegration(handle);
  expect(revision.changedPaths).toEqual(["vendor/lib.js"]);
  expect(revision.uncapturedPaths).toBeUndefined();
  yield* service.integrate(integration);
  expect(yield* readText(root, "vendor/lib.js")).toBe("vendored\n");
  expect(yield* exists(path.join(root, "node_modules"))).toBe(false);
});

test("refuses to replace a parent file the capture left out", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  // The worker stops ignoring ignored.ts and adds one; the parent's own ignored copy stays.
  yield* writeFile(path.join(handle.cwd, ".gitignore"), "\n");
  yield* writeFile(path.join(handle.cwd, "ignored.ts"), "worker\n");
  const { integration } = yield* prepareIntegration(handle);
  yield* writeFile(path.join(root, "ignored.ts"), "parent's ignored file\n");
  const refused = yield* failureOf(service.integrate(integration));
  expect(refused.code).toBe("workspace_parent_changed");
  expect(refused.detail).toContain('"ignored.ts"');
  expect(yield* readText(root, "ignored.ts")).toBe("parent's ignored file\n");
  expect(yield* readText(root, ".gitignore")).toBe("ignored.ts\n");
});
