import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { assert, expect, vi } from "vitest";
import { git } from "../../src/boundary/git-worktree-process.ts";
import { exportBranchName } from "../../src/workspace/policy.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
  openWorkspaceService,
  readText,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const test = workspaceTests([
  ["src/a.ts", "a\nb\nc\n"],
  ["src/b.ts", "one\n"],
  ["src/gone.ts", "gone\n"],
]);

/** Everything Git reports about the user's checkout that an export must leave alone. */
const checkoutState = (root: string) =>
  Effect.gen(function* () {
    return {
      head: yield* git(root, ["rev-parse", "HEAD"]),
      branch: yield* git(root, ["symbolic-ref", "-q", "HEAD"]),
      staged: yield* git(root, ["ls-files", "--stage"]),
      status: yield* git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    };
  });

const editWorker = (handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nworker\nc\n");
    yield* writeFile(path.join(handle.cwd, "src/new.ts"), "new\n");
    yield* io(() => fs.unlink(path.join(handle.cwd, "src/gone.ts")));
  });

const frozenProposal = (service: WorkspaceServiceContract, root: string) =>
  Effect.gen(function* () {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* editWorker(handle);
    const revision = yield* service.freeze(workspaceTarget(handle));
    return { handle, revision };
  });

test("exports a frozen revision as a patch under the Git directory that git apply accepts", function* (service, root) {
  const { handle, revision } = yield* frozenProposal(service, root);
  const before = yield* checkoutState(root);
  const exported = yield* service.exportRevision({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    export: { format: "patch" },
  });
  expect(exported).toMatchObject({
    format: "patch",
    revisionId: revision.revisionId,
    changedPaths: ["src/a.ts", "src/gone.ts", "src/new.ts"],
  });
  assert(exported.format === "patch");
  expect(exported.path.startsWith(path.join(root, ".git", "pi-subagents") + path.sep)).toBe(true);
  expect(yield* checkoutState(root)).toEqual(before);
  // Exporting again rewrites the same file rather than failing or adding another.
  yield* service.exportRevision({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    export: { format: "patch" },
  });
  expect(yield* io(() => fs.readdir(path.dirname(exported.path)))).toEqual([
    path.basename(exported.path),
  ]);
  expect((yield* service.inspect(workspaceTarget(handle))).status).toBe("frozen");
  yield* git(root, ["apply", exported.path]);
  expect(yield* readText(root, "src/a.ts")).toBe("a\nworker\nc\n");
  expect(yield* readText(root, "src/new.ts")).toBe("new\n");
  expect(yield* exists(path.join(root, "src/gone.ts"))).toBe(false);
});

test("exports a branch whose commit extends HEAD without touching the index, HEAD, or files", function* (service, root) {
  const { handle, revision } = yield* frozenProposal(service, root);
  // Unrelated local work must survive untouched.
  yield* writeFile(path.join(root, "src/b.ts"), "local edit\n");
  const before = yield* checkoutState(root);
  const branch = exportBranchName("Token parser", handle.workspaceId);
  expect(branch).toBe("pi-subagent/token-parser");
  const exported = yield* service.exportRevision({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    export: { format: "branch", branch },
  });
  expect(yield* checkoutState(root)).toEqual(before);
  assert(exported.format === "branch");
  expect(exported.base).toBe(before.head.trim());
  expect((yield* git(root, ["rev-parse", `${branch}^`])).trim()).toBe(before.head.trim());
  expect(yield* git(root, ["show", `${branch}:src/a.ts`])).toBe("a\nworker\nc\n");
  expect(yield* git(root, ["show", `${branch}:src/b.ts`])).toBe("one\n");
  expect(
    (yield* git(root, ["diff", "--name-only", `${branch}^`, branch])).trim().split("\n"),
  ).toEqual(["src/a.ts", "src/gone.ts", "src/new.ts"]);
  const again = yield* failureOf(
    service.exportRevision({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      export: { format: "branch", branch },
    }),
  );
  expect(again.code).toBe("workspace_branch_exists");
  expect((yield* git(root, ["rev-parse", branch])).trim()).toBe(exported.commit);
});

const IDENTITY_ENVIRONMENT = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

/** Stubs the identity variables for the test's scope, unset unless `values` names them. */
const identityEnvironment = (values: Readonly<Record<string, string>> = {}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      for (const key of IDENTITY_ENVIRONMENT) vi.stubEnv(key, values[key]);
      for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );

const commitIdentities = (root: string, branch: string) =>
  git(root, ["log", "-1", "--format=%an <%ae>%n%cn <%ce>", branch]).pipe(
    Effect.map((output) => output.trim().split("\n")),
  );

test("commits an exported branch as the user's identity for the source repository", function* (service, root) {
  yield* identityEnvironment();
  yield* git(root, ["config", "user.name", "Ada Lovelace"]);
  yield* git(root, ["config", "user.email", "ada@example.invalid"]);
  const { handle, revision } = yield* frozenProposal(service, root);
  const branch = "pi-subagent/identity";
  const exported = yield* service.exportRevision({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    export: { format: "branch", branch },
  });
  expect(exported).toMatchObject({ format: "branch", identity: "user" });
  expect(yield* commitIdentities(root, branch)).toEqual([
    "Ada Lovelace <ada@example.invalid>",
    "Ada Lovelace <ada@example.invalid>",
  ]);
});

test("lets GIT_AUTHOR_* override the configured identity for an exported branch", function* (service, root) {
  yield* identityEnvironment({
    GIT_AUTHOR_NAME: "Grace Hopper",
    GIT_AUTHOR_EMAIL: "grace@example.invalid",
  });
  yield* git(root, ["config", "user.name", "Ada Lovelace"]);
  yield* git(root, ["config", "user.email", "ada@example.invalid"]);
  const { handle, revision } = yield* frozenProposal(service, root);
  const branch = "pi-subagent/override";
  yield* service.exportRevision({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    export: { format: "branch", branch },
  });
  expect(yield* commitIdentities(root, branch)).toEqual([
    "Grace Hopper <grace@example.invalid>",
    "Ada Lovelace <ada@example.invalid>",
  ]);
});

test("falls back to the placeholder identity only when none is configured, and says so", function* (service, root) {
  yield* identityEnvironment({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const { handle, revision } = yield* frozenProposal(service, root);
  const branch = "pi-subagent/placeholder";
  const exported = yield* service.exportRevision({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    export: { format: "branch", branch },
  });
  expect(exported).toMatchObject({ format: "branch", identity: "placeholder" });
  expect(yield* commitIdentities(root, branch)).toEqual([
    "Pi workspace <workspace@invalid>",
    "Pi workspace <workspace@invalid>",
  ]);
});

test("refuses a branch when the proposal builds on uncommitted edits, leaving no branch", function* (service, root) {
  yield* writeFile(path.join(root, "src/a.ts"), "a\nlocal\nc\n");
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nlocal and worker\nc\n");
  const revision = yield* service.freeze(workspaceTarget(handle));
  const failure = yield* failureOf(
    service.exportRevision({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      export: { format: "branch", branch: "pi-subagent/conflict" },
    }),
  );
  expect(failure.code).toBe("workspace_conflict");
  expect(
    yield* git(root, ["branch", "--list", "pi-subagent/conflict"]).pipe(
      Effect.map((out) => out.trim()),
    ),
  ).toBe("");
  // The patch still applies to the checkout it was captured from.
  const exported = yield* service.exportRevision({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    export: { format: "patch" },
  });
  assert(exported.format === "patch");
  yield* git(root, ["apply", "--check", exported.path]);
});

it.live(
  "exports an orphan's unfrozen worker only once its session has ended, without changing it",
  () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("pi-orphan-export-");
      const source = path.join(temporary, "source");
      const agent = path.join(temporary, "agent");
      yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
      yield* commitRepository(source, [["src/a.ts", "a\n"]]);
      const creator = yield* openWorkspaceService(agent);
      const handle = yield* creator.service.create({ sourceCwd: source, ownerId: "old/root" });
      yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nworker\n");
      const other = yield* openWorkspaceService(agent);
      const running = yield* failureOf(
        other.service.exportOrphan({
          workspaceId: handle.workspaceId,
          export: { format: "patch" },
        }),
      );
      expect(running.operation).toBe("authorization");
      expect(yield* exists(path.join(source, ".git", "pi-subagents"))).toBe(false);
      yield* creator.close;
      const exported = yield* other.service.exportOrphan({
        workspaceId: handle.workspaceId,
        export: { format: "patch" },
      });
      expect(exported.changedPaths).toEqual(["src/a.ts"]);
      const record = (yield* other.service.listAll).records[0];
      expect(record?.status).toBe("active");
      expect(record?.revision).toBeUndefined();
      expect(yield* readText(handle.cwd, "src/a.ts")).toBe("a\nworker\n");
      assert(exported.format === "patch");
      yield* git(source, ["apply", exported.path]);
      expect(yield* readText(source, "src/a.ts")).toBe("a\nworker\n");
      yield* other.close;
    }),
  60_000,
);

test("integrates only the chosen paths and keeps the rest as the workspace's proposal", function* (service, root) {
  const { handle, revision } = yield* frozenProposal(service, root);
  const target = workspaceTarget(handle);
  const unknown = yield* failureOf(
    service.prepare({ ...target, revisionId: revision.revisionId, paths: ["src/b.ts"] }),
  );
  expect(unknown.operation).toBe("prepare");
  expect(unknown.detail).toContain('"src/b.ts"');
  const preparation = yield* service.prepare({
    ...target,
    revisionId: revision.revisionId,
    paths: ["src/new.ts", "src/a.ts"],
  });
  expect(preparation.paths).toEqual(["src/a.ts", "src/new.ts"]);
  const integration = yield* service.integrate({
    ...target,
    revisionId: revision.revisionId,
    preparationId: preparation.preparationId,
  });
  expect(integration.remainingPaths).toEqual(["src/gone.ts"]);
  expect(integration.record.status).toBe("active");
  expect(yield* readText(root, "src/a.ts")).toBe("a\nworker\nc\n");
  expect(yield* readText(root, "src/new.ts")).toBe("new\n");
  expect(yield* exists(path.join(root, "src/gone.ts"))).toBe(true);
  expect(yield* exists(path.join(handle.cwd, "src/new.ts"))).toBe(true);
  expect(yield* exists(preparation.cwd)).toBe(false);
  const rest = yield* service.freeze(target);
  expect(rest.changedPaths).toEqual(["src/gone.ts"]);
  const final = yield* service.prepare({ ...target, revisionId: rest.revisionId });
  yield* service.integrate({
    ...target,
    revisionId: rest.revisionId,
    preparationId: final.preparationId,
  });
  expect(yield* exists(path.join(root, "src/gone.ts"))).toBe(false);
  expect((yield* service.inspect(target)).status).toBe("integrated");
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
  // Setup in the rebuilt tree is judged against it, not against the new baseline.
  expect(yield* service.setupChanges(target)).toEqual([]);
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
