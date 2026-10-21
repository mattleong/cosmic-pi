import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import * as gitProcess from "../../src/boundary/git-worktree-process.ts";
import { type WorkspaceHandle } from "../../src/workspace/model.ts";
import {
  exists,
  failureOf,
  fails,
  integrateFailingRemoval,
  io,
  prepareIntegration,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const { git } = gitProcess;

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

const isSymlink = (file: string) =>
  io(() =>
    fs.lstat(file).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    ),
  );

test("applies added, changed, deleted, mode-changed, and symlink paths without touching the parent index", function* (service, root) {
  yield* addInternalAliases(root);
  yield* git(root, ["commit", "-q", "-m", "aliases"]);
  const indexEntries = git(root, ["ls-files", "-s"]);
  const before = yield* indexEntries;
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  const worker = handle.cwd;
  yield* writeFile(path.join(worker, "added.ts"), "added\n");
  yield* writeFile(path.join(worker, "src/main.ts"), "changed\n");
  yield* io(() => fs.unlink(path.join(worker, "binary.dat")));
  yield* io(() => fs.chmod(path.join(worker, "other.txt"), 0o755));
  yield* io(() => fs.symlink("src/main.ts", path.join(worker, "main-link.ts")));
  yield* io(() => fs.unlink(path.join(worker, "CLAUDE.md")));
  yield* io(() => fs.symlink("other.txt", path.join(worker, "CLAUDE.md")));
  yield* io(() => fs.unlink(path.join(worker, "src/alias.md")));
  yield* writeFile(path.join(worker, "src/alias.md"), "regular now\n");
  const { revision, integration } = yield* prepareIntegration(service, handle);
  expect(revision.changedPaths).toEqual([
    "CLAUDE.md",
    "added.ts",
    "binary.dat",
    "main-link.ts",
    "other.txt",
    "src/alias.md",
    "src/main.ts",
  ]);
  yield* service.integrate(integration);
  expect(yield* readText(root, "added.ts")).toBe("added\n");
  expect(yield* readText(root, "src/main.ts")).toBe("changed\n");
  expect(yield* exists(path.join(root, "binary.dat"))).toBe(false);
  expect(yield* readText(root, "other.txt")).toBe("other\n");
  expect((yield* io(() => fs.stat(path.join(root, "other.txt")))).mode & 0o111).not.toBe(0);
  expect(yield* io(() => fs.readlink(path.join(root, "main-link.ts")))).toBe("src/main.ts");
  expect(yield* io(() => fs.readlink(path.join(root, "CLAUDE.md")))).toBe("other.txt");
  expect(yield* isSymlink(path.join(root, "src/alias.md"))).toBe(false);
  expect(yield* readText(root, "src/alias.md")).toBe("regular now\n");
  expect(yield* readText(root, "AGENTS.md")).toBe("original instructions\n");
  expect(yield* indexEntries).toBe(before);
});

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
  } = yield* prepareIntegration(service, handle);
  expect(review.changedPaths).toContain("binary.dat");
  expect(yield* readText(preparation.cwd, "main.ts")).toBe("worker\n");
  yield* service.integrate(integration);
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  expect(yield* readText(root, "feature/nested/new.ts")).toBe("new nested source\n");
  expect(yield* io(() => fs.readFile(path.join(root, "binary.dat")))).toEqual(
    Buffer.from([0, 250, 1, 2]),
  );
  expect((yield* io(() => fs.stat(path.join(root, "src/main.ts")))).mode & 0o111).not.toBe(0);
  expect(yield* exists(path.join(root, "other.txt"))).toBe(false);
  expect(yield* io(() => fs.readFile(path.join(root, ".git/index")))).toEqual(index);
  expect(yield* git(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(yield* readText(root, ".env")).toBe("SECRET=never-copy-this-head-value\n");
});

// The checkout step writes all but the last of its paths, then fails, as a crash partway would.
const stopCheckoutBeforeLast = () => {
  const original = gitProcess.git;
  return vi.spyOn(gitProcess, "git").mockImplementation((cwd, args, options) => {
    if (args[0] !== "checkout-index" || options?.stdin === undefined)
      return original(cwd, args, options);
    const paths = new TextDecoder().decode(options.stdin).split("\0").filter(Boolean);
    const written = new TextEncoder().encode(
      paths
        .slice(0, -1)
        .map((name) => `${name}\0`)
        .join(""),
    );
    return original(cwd, args, { ...options, stdin: written }).pipe(
      Effect.andThen(Effect.fail(gitProcess.workspaceFailure("git", "injected"))),
    );
  });
};

test("discard puts back the files an integration stopped partway through", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() => fs.mkdir(path.join(handle.cwd, "feature")));
  yield* writeFile(path.join(handle.cwd, "feature/new.ts"), "new\n");
  yield* writeFile(path.join(handle.cwd, "other.txt"), "worker other\n");
  yield* io(() => fs.chmod(path.join(handle.cwd, "other.txt"), 0o755));
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker main\n");
  yield* io(() => fs.unlink(path.join(handle.cwd, "binary.dat")));
  const { integration } = yield* prepareIntegration(service, handle);
  const spy = stopCheckoutBeforeLast();
  const failure = yield* failureOf(service.integrate(integration)).pipe(
    Effect.ensuring(Effect.sync(() => spy.mockRestore())),
  );
  expect(failure.detail).toContain("mid-integration");
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("integrating");
  expect(yield* readText(root, "feature/new.ts")).toBe("new\n");
  expect(yield* readText(root, "other.txt")).toBe("worker other\n");
  expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
  expect(yield* exists(path.join(root, "binary.dat"))).toBe(true);

  yield* service.discard(workspaceTarget(handle));
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("discarded");
  expect(yield* exists(path.join(root, "feature"))).toBe(false);
  expect(yield* readText(root, "other.txt")).toBe("other\n");
  expect((yield* io(() => fs.stat(path.join(root, "other.txt")))).mode & 0o111).toBe(0);
  expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
  expect(yield* io(() => fs.readFile(path.join(root, "binary.dat")))).toEqual(
    Buffer.from([0, 255, 13, 10]),
  );
  expect(yield* exists(handle.cwd)).toBe(false);
});

test("refuses rollback while a touched file holds neither side, then completes it", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker main\n");
  yield* io(() => fs.unlink(path.join(handle.cwd, "binary.dat")));
  yield* io(() => fs.unlink(path.join(handle.cwd, "other.txt")));
  const { integration } = yield* prepareIntegration(service, handle);
  // binary.dat is removed first; other.txt stays.
  yield* integrateFailingRemoval(service, integration, path.join(root, "other.txt"));
  expect(yield* exists(path.join(root, "binary.dat"))).toBe(false);
  yield* writeFile(path.join(root, "src/main.ts"), "edited after the stop\n");

  const refused = yield* failureOf(service.discard(workspaceTarget(handle)));
  expect(refused.code).toBe("workspace_rollback_refused");
  expect(refused.detail).toContain('"src/main.ts"');
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("integrating");
  expect(yield* readText(root, "src/main.ts")).toBe("edited after the stop\n");
  expect(yield* exists(path.join(root, "binary.dat"))).toBe(false);

  yield* writeFile(path.join(root, "src/main.ts"), "worker main\n");
  yield* service.discard(workspaceTarget(handle));
  expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
  expect(yield* readText(root, "other.txt")).toBe("other\n");
  expect(yield* io(() => fs.readFile(path.join(root, "binary.dat")))).toEqual(
    Buffer.from([0, 255, 13, 10]),
  );
});

test("publishes over a parent file with a setuid bit, which the new content doesn't keep", function* (service, root) {
  yield* io(() => fs.chmod(path.join(root, "src/main.ts"), 0o4755));
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
  const { integration } = yield* prepareIntegration(service, handle);
  const integrated = yield* service.integrate(integration);
  expect(integrated.record.status).toBe("integrated");
  expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  expect((yield* io(() => fs.stat(path.join(root, "src/main.ts")))).mode & 0o7777).toBe(0o755);
});

test("keeps a frozen revision's patch out of its record and reads it back", function* (service, root, agent) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker change\n");
  const { revision, integration } = yield* prepareIntegration(service, handle);
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
  const { prepared, integration: request } = yield* prepareIntegration(service, handle);
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
  const { integration } = yield* prepareIntegration(service, handle);
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
  const { revision, prepared, integration } = yield* prepareIntegration(service, handle);
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
  const { revision, integration } = yield* prepareIntegration(service, handle);
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
  const { revision, integration } = yield* prepareIntegration(service, handle);
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
  const { integration } = yield* prepareIntegration(service, handle);
  yield* writeFile(path.join(root, "ignored.ts"), "parent's ignored file\n");
  const refused = yield* failureOf(service.integrate(integration));
  expect(refused.code).toBe("workspace_parent_changed");
  expect(refused.detail).toContain('"ignored.ts"');
  expect(yield* readText(root, "ignored.ts")).toBe("parent's ignored file\n");
  expect(yield* readText(root, ".gitignore")).toBe("ignored.ts\n");
});
