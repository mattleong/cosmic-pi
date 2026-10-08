import { expect, vi } from "vitest";
import * as publication from "../../src/boundary/git-worktree-integration.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { git } from "../../src/boundary/git-worktree-process.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
import { WriterLeaseService } from "../../src/boundary/writer-lease.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
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

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["other.txt", "other\n"],
  ["binary.dat", new Uint8Array([0, 255, 13, 10])],
  [".env", "SECRET=never-copy-this-head-value\n"],
  [".gitignore", "ignored.ts\n"],
]);
/** Freezes and prepares a workspace, returning the matching integration request. */
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

test("rejects an empty ancestor created after prepare, including an active nested writer", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.mkdir(path.join(handle.cwd, "feature/nested"), { recursive: true }));
  yield* writeFile(path.join(handle.cwd, "feature/nested/new.ts"), "new\n");
  const { integration } = yield* prepareIntegration(handle);
  const ancestor = path.join(root, "feature");
  yield* io(() => fs.mkdir(ancestor));
  expect((yield* failureOf(service.integrate(integration))).message).toContain("ancestors changed");
  const leases = yield* WriterLeaseService.pipe(
    Effect.provide(WriterLeaseService.layer({ agentDirectory: agent })),
  );
  const cwd = yield* leases.canonicalize(ancestor);
  yield* Effect.acquireUseRelease(
    leases.acquire({ cwd, runId: "nested-writer" }),
    () =>
      Effect.gen(function* () {
        expect((yield* failureOf(service.integrate(integration))).message).toContain(
          "ancestors changed",
        );
        expect(yield* io(() => fs.readdir(ancestor))).toEqual([]);
        expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("prepared");
      }),
    (lease) => leases.release(lease).pipe(Effect.orDie),
  );
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
      // This owned boundary is called only after requiredLeaseDirectories succeeds.
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

test("reports and owns a create interrupted while it commits the active record", function* (service, root) {
  const reported: WorkspaceHandle[] = [];
  const rename = fs.rename;
  let interrupt = () => {};
  const spy = vi.spyOn(fs, "rename").mockImplementation((from, to) =>
    fs.readFile(from, "utf8").then((text) => {
      if (String(to).endsWith("record.json") && text.includes('"status":"active"')) interrupt();
      return rename(from, to);
    }),
  );
  const launch = yield* Effect.forkChild(
    service.create({ sourceCwd: root, ownerId: "parent", onAcquired: (h) => reported.push(h) }),
  );
  interrupt = () => launch.interruptUnsafe();
  const exit = yield* Fiber.await(launch).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(Exit.hasInterrupts(exit)).toBe(true);
  // The launch learned of its workspace, so its own cleanup can still discard it.
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

test("preserves tracked internal aliases through snapshot, fork and regular-file integration", function* (service, root) {
  yield* addInternalAliases(root);
  yield* writeFile(path.join(root, "AGENTS.md"), "current instructions\n");
  const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
  const head = yield* git(root, ["rev-parse", "HEAD"]);
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* io(() => fs.readlink(path.join(handle.cwd, "CLAUDE.md")))).toBe("AGENTS.md");
  expect(yield* readText(handle.cwd, "src/alias.md")).toBe("current instructions\n");
  const fork = yield* service.fork(workspaceTarget(handle));
  expect(yield* io(() => fs.readlink(path.join(fork.cwd, "CLAUDE.md")))).toBe("AGENTS.md");
  yield* writeFile(path.join(handle.cwd, "AGENTS.md"), "reviewed instructions\n");
  const { revision, prepared, integration } = yield* prepareIntegration(handle);
  expect(revision.changedPaths).toEqual(["AGENTS.md"]);
  expect(yield* io(() => fs.readlink(path.join(prepared.cwd, "CLAUDE.md")))).toBe("AGENTS.md");
  yield* service.integrate(integration);
  expect(yield* io(() => fs.readlink(path.join(root, "CLAUDE.md")))).toBe("AGENTS.md");
  expect(yield* readText(root, "CLAUDE.md")).toBe("reviewed instructions\n");
  expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
  expect(yield* git(root, ["rev-parse", "HEAD"])).toBe(head);
});

for (const linkTarget of [
  "/etc/passwd",
  "../outside.txt",
  ".env",
  "missing.md",
  "src",
  "CLAUDE.md",
  "src/alias.md",
  ".git/config",
  "missing/../AGENTS.md",
  "node_modules/../AGENTS.md",
  "./AGENTS.md",
  "\uFEFFAGENTS.md",
]) {
  test(`rejects unsafe tracked alias target ${linkTarget} before retaining a workspace`, function* (service, root) {
    yield* addInternalAliases(root);
    yield* io(() => fs.unlink(path.join(root, "CLAUDE.md")));
    yield* io(() => fs.symlink(linkTarget, path.join(root, "CLAUDE.md")));
    const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
    expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
    expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
    expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
  });
}

test("does not normalize traversal through an excluded external directory symlink", function* (service, root) {
  yield* addInternalAliases(root);
  const outside = path.join(path.dirname(root), "external");
  yield* io(() => fs.mkdir(path.join(outside, "nested"), { recursive: true }));
  yield* writeFile(path.join(outside, "AGENTS.md"), "outside instructions\n");
  yield* io(() => fs.symlink(path.join(outside, "nested"), path.join(root, "node_modules")));
  yield* io(() => fs.unlink(path.join(root, "CLAUDE.md")));
  yield* io(() => fs.symlink("node_modules/../AGENTS.md", path.join(root, "CLAUDE.md")));
  expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
  expect(yield* readText(outside, "AGENTS.md")).toBe("outside instructions\n");
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
  expect(yield* git(worker, ["log", "--all", "--format=", "--name-only"])).not.toContain(".env");
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
  yield* writeFile(path.join(root, "other.txt"), "late parent\n");
  expect(yield* fails(service.integrate(request))).toBe(true);
  expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
  expect(yield* readText(root, "other.txt")).toBe("late parent\n");
});

test("removes spent editable trees only after a committed integration", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { prepared, integration } = yield* prepareIntegration(handle);
  yield* writeFile(path.join(root, "src/main.ts"), "late parent\n");
  expect(yield* fails(service.integrate(integration))).toBe(true);
  expect(yield* exists(handle.cwd)).toBe(true);
  expect(yield* exists(prepared.cwd)).toBe(true);
  yield* writeFile(path.join(root, "src/main.ts"), "baseline\n");
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("integrated");
  expect(yield* exists(handle.cwd)).toBe(false);
  expect(yield* exists(prepared.cwd)).toBe(false);
});

test("retains integrated trees on request", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "other.txt"), "worker\n");
  const { prepared, integration } = yield* prepareIntegration(handle);
  yield* service.integrate({ ...integration, retainTrees: true });
  expect(yield* readText(root, "other.txt")).toBe("worker\n");
  expect(yield* readText(handle.cwd, "other.txt")).toBe("worker\n");
  expect(yield* exists(prepared.cwd)).toBe(true);
});

test("keeps the worker when it holds files the integrated revision left out", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const invoice = path.join(handle.cwd, "src/Billing/Invoice.cs");
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  yield* io(() => fs.mkdir(path.dirname(invoice), { recursive: true }));
  yield* writeFile(invoice, "class Invoice {}\n");
  // Ignored by the source's own rules, so it is disposable output that keeps nothing.
  yield* writeFile(path.join(handle.cwd, "ignored.ts"), "output\n");
  const { revision, prepared, integration } = yield* prepareIntegration(handle);
  expect(revision.changedPaths).toEqual(["src/main.ts"]);
  const integrated = yield* service.integrate(integration);
  expect(integrated.uncapturedPaths).toEqual(["src/Billing/Invoice.cs"]);
  expect(integrated.record.status).toBe("integrated");
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  expect(yield* exists(path.join(root, "src/Billing/Invoice.cs"))).toBe(false);
  expect(yield* readText(integrated.workerRoot, "src/Billing/Invoice.cs")).toBe(
    "class Invoice {}\n",
  );
  expect(yield* exists(prepared.cwd)).toBe(false);
  // Discarding the integrated workspace afterwards deletes the kept worker.
  yield* service.discard(workspaceTarget(handle));
  expect(yield* exists(handle.cwd)).toBe(false);
});

test("keeps the worker for writer files at paths the source itself left out", function* (service, root) {
  // The source tracks an excluded vendor file and holds an ineligible untracked file.
  yield* io(() => fs.mkdir(path.join(root, "vendor")));
  yield* writeFile(path.join(root, "vendor/lib.go"), "package lib\n");
  yield* git(root, ["add", "vendor/lib.go"]);
  yield* git(root, ["commit", "-m", "vendor"]);
  yield* writeFile(path.join(root, "notes.cs"), "source notes\n");
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* exists(path.join(handle.cwd, "vendor/lib.go"))).toBe(false);
  expect(yield* exists(path.join(handle.cwd, "notes.cs"))).toBe(false);
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  yield* writeFile(path.join(handle.cwd, "notes.cs"), "writer notes\n");
  yield* io(() => fs.mkdir(path.join(handle.cwd, "vendor")));
  yield* writeFile(path.join(handle.cwd, "vendor/lib.go"), "package patched\n");
  yield* writeFile(path.join(handle.cwd, ".env"), "LOCAL=1\n");
  const { revision, integration } = yield* prepareIntegration(handle);
  expect(revision.changedPaths).toEqual(["src/main.ts"]);
  const integrated = yield* service.integrate(integration);
  expect([...integrated.uncapturedPaths].sort()).toEqual([".env", "notes.cs", "vendor/lib.go"]);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  expect(yield* readText(root, "notes.cs")).toBe("source notes\n");
  expect(yield* readText(root, "vendor/lib.go")).toBe("package lib\n");
  expect(yield* readText(integrated.workerRoot, "notes.cs")).toBe("writer notes\n");
  expect(yield* readText(integrated.workerRoot, "vendor/lib.go")).toBe("package patched\n");
});

test("keeps a fork's worker for writer files at paths its source left out", function* (service, root) {
  const original = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const fork = yield* service.fork(workspaceTarget(original));
  expect(yield* exists(path.join(fork.cwd, ".env"))).toBe(false);
  yield* writeFile(path.join(fork.cwd, "src/main.ts"), "retry\n");
  yield* writeFile(path.join(fork.cwd, ".env"), "LOCAL=1\n");
  const { integration } = yield* prepareIntegration(fork);
  const integrated = yield* service.integrate(integration);
  expect(integrated.uncapturedPaths).toEqual([".env"]);
  expect(yield* readText(root, "src/main.ts")).toBe("retry\n");
  expect(yield* readText(integrated.workerRoot, ".env")).toBe("LOCAL=1\n");
});

test("forks the original baseline, invalidates revisions and retains recovery metadata", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "failed attempt\n");
  const revision = yield* service.freeze(workspaceTarget(handle));
  const fork = yield* service.fork(workspaceTarget(handle));
  expect(yield* readText(fork.cwd, "src/main.ts")).toBe("baseline\n");
  expect(yield* readText(handle.cwd, "src/main.ts")).toBe("failed attempt\n");
  yield* service.revise(workspaceTarget(handle));
  expect(
    yield* fails(service.prepare({ ...workspaceTarget(handle), revisionId: revision.revisionId })),
  ).toBe(true);
  expect(yield* fails(service.inspect({ ...workspaceTarget(handle), ownerId: "sibling" }))).toBe(
    true,
  );
  yield* Effect.gen(function* () {
    const recovered = yield* WorkspaceService;
    expect((yield* recovered.listAll).records.length).toBe(2);
    expect(yield* fails(recovered.freeze(workspaceTarget(handle)))).toBe(true);
    expect(yield* fails(recovered.discard(workspaceTarget(handle)))).toBe(true);
  }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: agent })));
  expect(yield* exists(handle.cwd)).toBe(true);
  yield* service.discard(workspaceTarget(fork));
  expect(yield* exists(fork.cwd)).toBe(false);
});

for (const mismatch of ["seed", "owner", "source", "registration"] as const) {
  test(`never discards a fork whose seed provenance is unsafe: ${mismatch}`, function* (service, root, agent) {
    const original = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const fork = yield* service.fork(workspaceTarget(original));
    const registry = path.join(agent, "git-workspaces");
    const seed = path.join(registry, fork.workspaceId, "seed");
    if (mismatch === "seed") yield* io(() => fs.mkdir(seed));
    else if (mismatch === "registration") {
      // A live seed registration without its tree needs manual inspection, never a broad prune.
      const predecessor = yield* service.inspect(workspaceTarget(original));
      const repository = path.join(registry, original.workspaceId, "repo.git");
      yield* git(repository, ["worktree", "add", "--detach", seed, predecessor.baseline]);
      yield* io(() => fs.rm(seed, { recursive: true, force: true }));
    } else {
      const predecessor = yield* service.inspect(workspaceTarget(original));
      const other = path.join(root, "other");
      const handle =
        mismatch === "owner"
          ? { ...predecessor.handle, ownerId: "other" }
          : { ...predecessor.handle, sourceRoot: other, sourceCwd: other };
      yield* writeFile(
        path.join(registry, original.workspaceId, "record.json"),
        JSON.stringify({ ...predecessor, handle }),
      );
    }
    expect(yield* failureOf(service.discard(workspaceTarget(fork)))).toMatchObject({
      _tag: "WorkspaceError",
      operation: "recovery",
    });
    expect(yield* exists(fork.cwd)).toBe(true);
    expect((yield* service.inspect(workspaceTarget(fork))).status).toBe("active");
  });
}

test("rejects source symlinks, hardlinks and sensitive literals before copying", function* (service, root) {
  yield* io(() => fs.symlink("main.ts", path.join(root, "src/link.ts")));
  expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
  yield* io(() => fs.unlink(path.join(root, "src/link.ts")));
  yield* io(() => fs.link(path.join(root, "src/main.ts"), path.join(root, "src/link.ts")));
  expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
  yield* io(() => fs.unlink(path.join(root, "src/link.ts")));
  yield* writeFile(
    path.join(root, "src/main.ts"),
    `const apiKey = "${"ghp_" + "A".repeat(36)}";\n`,
  );
  expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
});

test("rejects non-UTF8 text before snapshot and keeps parent bytes/index exact", function* (service, root) {
  const bytes = Buffer.from([99, 97, 102, 233, 10]);
  yield* writeFile(path.join(root, "src/main.ts"), bytes);
  const index = yield* io(() => fs.readFile(path.join(root, ".git/index")));
  expect(yield* fails(service.create({ sourceCwd: root, ownerId: "parent" }))).toBe(true);
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
  expect(yield* io(() => fs.readFile(path.join(root, "src/main.ts")))).toEqual(bytes);
  expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
});

test("captures removed tracked directories as deletions and starts read-only without storage", function* (service, root, agent) {
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });
  expect(yield* exists(path.join(agent, "git-workspaces"))).toBe(false);
  yield* io(() => fs.rm(path.join(root, "src"), { recursive: true }));
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* exists(path.join(handle.cwd, "src"))).toBe(false);
  expect((yield* service.inspect(workspaceTarget(handle))).excludedPaths).toContain(".env");
});
