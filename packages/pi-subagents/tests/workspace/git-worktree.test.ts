import { expect, vi } from "vitest";
import * as publication from "../../src/boundary/git-worktree-integration.ts";
import * as files from "../../src/boundary/git-worktree-publish.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { git } from "../../src/boundary/git-worktree-process.ts";
import { WorkspaceService } from "../../src/workspace/service.ts";
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

for (const linkTarget of ["/etc/passwd", "../outside.txt", ".git/config"]) {
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

const publicationArtifacts = (root: string) =>
  io(() => fs.readdir(root, { recursive: true })).pipe(
    Effect.map((names) =>
      names.filter((name) => path.basename(name).startsWith(".pi-workspace-")).toSorted(),
    ),
  );

test("keeps backups for manual recovery when publication stops partway", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "other.txt"), "published first\n");
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "never published\n");
  const { integration } = yield* prepareIntegration(handle);
  const original = files.publishWorkspaceFile;
  const spy = vi.spyOn(files, "publishWorkspaceFile").mockImplementation((request) =>
    Effect.gen(function* () {
      if (request.name === "main.ts")
        yield* writeFile(path.join(request.directory, request.name), "editor save\n");
      return yield* original(request);
    }),
  );
  const failure = yield* failureOf(service.integrate(integration)).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(failure.message).toContain("No automatic rollback");
  const record = yield* service.inspect(workspaceTarget(handle));
  expect(record.status).toBe("integrating");
  expect(record.publishedCount).toBe(1);
  expect(yield* readText(root, "other.txt")).toBe("published first\n");
  expect(yield* readText(root, "src/main.ts")).toBe("editor save\n");
  const backups = (record.journal ?? []).map((entry) => entry.backupPath).toSorted();
  expect(yield* publicationArtifacts(root)).toEqual(backups);
  expect(yield* readText(root, backups[0]!)).toBe("other\n");
  expect(yield* fails(service.discard(workspaceTarget(handle)))).toBe(true);
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

test("keeps the worker when it holds files the integrated revision left out", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const invoice = path.join(handle.cwd, "src/Billing/Invoice.cs");
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  yield* io(() => fs.mkdir(path.dirname(invoice), { recursive: true }));
  yield* writeFile(invoice, "class Invoice {}\n");
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
  yield* service.discard(workspaceTarget(handle));
  expect(yield* exists(handle.cwd)).toBe(false);
});

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
