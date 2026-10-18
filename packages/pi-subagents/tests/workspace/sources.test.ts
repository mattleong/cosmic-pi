import { afterAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as os from "node:os";
import { git } from "../../src/boundary/git-worktree-process.ts";
import { sourceIdentity } from "../../src/boundary/git-repository.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
import { WorkspaceService, type WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
  readText,
  temporaryDirectory,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

// Every Git configuration these tests read comes from this isolated home, rewritten per test.
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-home-")));
const globalConfig = path.join(home, ".gitconfig");
await fs.writeFile(globalConfig, "");
vi.stubEnv("HOME", home);
vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
vi.stubEnv("XDG_CONFIG_HOME", undefined);
afterAll(() => fs.rm(home, { recursive: true, force: true }));

const userConfig = (text: string) => writeFile(globalConfig, text);

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["docs/guide.md", "guide\n"],
  ["..notes/plan.md", "plan\n"],
  [".gitignore", "*.log\n"],
]);

const integrate = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const target = workspaceTarget(handle);
    const revision = yield* service.freeze(target);
    const preparation = yield* service.prepare({ ...target, revisionId: revision.revisionId });
    return yield* service.integrate({
      ...target,
      revisionId: revision.revisionId,
      preparationId: preparation.preparationId,
    });
  });

const worktrees = (root: string) =>
  git(root, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map((output) =>
      output
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length)),
    ),
  );
const piRefs = (root: string) => git(root, ["for-each-ref", "--format=%(refname)", "refs/pi"]);

describe("ignore rules", () => {
  test("follows include directives in the user's global configuration", function* (service, root) {
    const included = path.join(home, "included.conf");
    yield* writeFile(included, `[core]\n\texcludesFile = ${path.join(home, "global-ignore")}\n`);
    yield* writeFile(path.join(home, "global-ignore"), "global-only.md\n");
    yield* userConfig(`[include]\n\tpath = ${included}\n`);
    yield* writeFile(path.join(root, "global-only.md"), "private\n");
    yield* writeFile(path.join(root, "notes.md"), "shared\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* userConfig("");
    expect(yield* exists(path.join(handle.cwd, "notes.md"))).toBe(true);
    expect(yield* exists(path.join(handle.cwd, "global-only.md"))).toBe(false);
  });

  test("applies the repository's info/exclude to worker captures and setup checks", function* (service, root) {
    const exclude = path.join(root, ".git", "info", "exclude");
    yield* io(() => fs.mkdir(path.dirname(exclude), { recursive: true }));
    yield* writeFile(exclude, "scratch.md\n");
    yield* writeFile(path.join(root, "scratch.md"), "source scratch\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* exists(path.join(handle.cwd, "scratch.md"))).toBe(false);

    yield* writeFile(path.join(handle.cwd, "scratch.md"), "hook output\n");
    expect(yield* service.hookChanges(workspaceTarget(handle))).toEqual([]);
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "changed\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    expect(revision.changedPaths).toEqual(["src/main.ts"]);
  });
});

describe("baselines", () => {
  test("carry staged, unstaged, and eligible untracked files, never credential-named or ignored ones", function* (service, root) {
    yield* writeFile(path.join(root, "src/main.ts"), "staged\n");
    yield* git(root, ["add", "--", "src/main.ts"]);
    yield* writeFile(path.join(root, "docs/guide.md"), "unstaged\n");
    yield* writeFile(path.join(root, "src/new.ts"), "untracked\n");
    yield* writeFile(path.join(root, "build.log"), "ignored\n");
    yield* writeFile(path.join(root, ".env"), "SECRET=1\n");
    yield* writeFile(path.join(root, "src/credentials.ts"), "export {};\n");
    yield* writeFile(path.join(root, "deploy.pem"), "key\n");
    yield* io(() => fs.mkdir(path.join(root, "nested")));
    yield* commitRepository(path.join(root, "nested"), [["inner.ts", "inner\n"]]);
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* readText(handle.cwd, "src/main.ts")).toBe("staged\n");
    expect(yield* readText(handle.cwd, "docs/guide.md")).toBe("unstaged\n");
    expect(yield* readText(handle.cwd, "src/new.ts")).toBe("untracked\n");
    for (const left of ["build.log", ".env", "src/credentials.ts", "deploy.pem", "nested"])
      expect(yield* exists(path.join(handle.cwd, left))).toBe(false);
    const baseline = (yield* service.inspect(workspaceTarget(handle))).baseline;
    const files = yield* git(root, ["ls-tree", "-r", "--name-only", baseline]);
    expect(files.split("\n").filter(Boolean).toSorted()).toEqual([
      "..notes/plan.md",
      ".gitignore",
      "docs/guide.md",
      "src/main.ts",
      "src/new.ts",
    ]);
  });
});

describe("the user's repository", () => {
  test("keeps its index, HEAD, branches, and stash, and never runs a hook", function* (service, root) {
    const marker = path.join(path.dirname(root), "hook-ran");
    const hook = `#!/bin/sh\necho "$0" >> "${marker}"\n`;
    yield* io(() => fs.mkdir(path.join(root, ".git", "hooks"), { recursive: true }));
    for (const name of ["post-checkout", "pre-commit", "post-commit", "reference-transaction"]) {
      yield* writeFile(path.join(root, ".git", "hooks", name), hook);
      yield* io(() => fs.chmod(path.join(root, ".git", "hooks", name), 0o755));
    }
    // A configured hooks path is overridden too.
    yield* git(root, ["config", "core.hooksPath", path.join(root, ".git", "hooks")]);
    yield* writeFile(path.join(root, "src/main.ts"), "staged\n");
    yield* git(root, ["add", "--", "src/main.ts"]);
    yield* writeFile(path.join(root, "src/main.ts"), "unstaged\n");
    const index = yield* io(() => fs.readFile(path.join(root, ".git", "index")));
    const head = yield* readText(root, ".git", "HEAD");
    const branches = yield* git(root, ["for-each-ref", "refs/heads", "refs/tags", "refs/stash"]);

    const kept = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(kept.cwd, "docs/guide.md"), "worker\n");
    yield* integrate(service, kept);
    const discarded = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(discarded.cwd, "src/added.ts"), "worker\n");
    const target = workspaceTarget(discarded);
    const revision = yield* service.freeze(target);
    yield* service.prepare({ ...target, revisionId: revision.revisionId });
    yield* service.rebase(target);
    yield* service.discard(target);

    expect(yield* readText(root, "docs/guide.md")).toBe("worker\n");
    expect(yield* readText(root, "src/main.ts")).toBe("unstaged\n");
    expect(yield* io(() => fs.readFile(path.join(root, ".git", "index")))).toEqual(index);
    expect(yield* readText(root, ".git", "HEAD")).toBe(head);
    expect(yield* git(root, ["for-each-ref", "refs/heads", "refs/tags", "refs/stash"])).toBe(
      branches,
    );
    expect(yield* exists(marker)).toBe(false);
  });

  test("adds no shared index to a split-index repository's Git directory", function* (service, root) {
    yield* git(root, ["config", "core.splitIndex", "true"]);
    // Every split write would make a new shared index.
    yield* git(root, ["config", "splitIndex.maxPercentChange", "0"]);
    yield* git(root, ["update-index", "--split-index"]);
    const sharedIndexes = io(() => fs.readdir(path.join(root, ".git"))).pipe(
      Effect.map((names) => names.filter((name) => name.startsWith("sharedindex.")).toSorted()),
    );
    const before = yield* sharedIndexes;
    yield* writeFile(path.join(root, "src/new.ts"), "untracked\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
    yield* integrate(service, handle);
    expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
    expect(yield* sharedIndexes).toEqual(before);
  });

  test("lists no worktree or ref of a workspace once it is discarded or integrated", function* (service, root, agent) {
    const discarded = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const integrated = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const target = workspaceTarget(discarded);
    yield* writeFile(path.join(discarded.cwd, "src/main.ts"), "discarded\n");
    const revision = yield* service.freeze(target);
    yield* service.prepare({ ...target, revisionId: revision.revisionId });
    expect((yield* worktrees(root)).filter((tree) => tree.startsWith(agent))).toHaveLength(3);
    expect(yield* piRefs(root)).toContain(discarded.workspaceId);
    // Git's administrative entries stay locked while the trees exist.
    expect(yield* git(root, ["worktree", "list", "--porcelain"])).toContain(
      `locked pi-subagents workspace ${discarded.workspaceId}`,
    );

    yield* service.discard(target);
    yield* writeFile(path.join(integrated.cwd, "src/main.ts"), "integrated\n");
    yield* integrate(service, integrated);
    expect(yield* worktrees(root)).toEqual([root]);
    expect(yield* piRefs(root)).toBe("");
  });

  test("removes a worker tree whose directory is gone, keeping the user's missing worktrees", function* (service, root) {
    // The user's own unlocked worktree whose directory was deleted: only the user may prune it.
    const mine = path.join(path.dirname(root), "mine");
    yield* git(root, ["worktree", "add", "-q", "--detach", mine]);
    yield* io(() => fs.rm(mine, { recursive: true, force: true }));
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* io(() => fs.rm(handle.cwd, { recursive: true, force: true }));
    yield* service.discard(workspaceTarget(handle));
    expect(yield* worktrees(root)).toEqual([root, mine]);
    expect(yield* piRefs(root)).toBe("");
  });
});

describe("local edits the parent index hides", () => {
  const hiding = [
    ["skip-worktree", "--skip-worktree"],
    ["assume-unchanged", "--assume-unchanged"],
  ] as const;

  for (const [bit, flag] of hiding)
    test(`refuses to prepare a changed file marked ${bit}, keeping its local edit`, function* (service, root) {
      yield* git(root, ["update-index", flag, "--", "src/main.ts"]);
      yield* writeFile(path.join(root, "src/main.ts"), "local override\n");
      const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
      yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
      const target = workspaceTarget(handle);
      const revision = yield* service.freeze(target);
      const refused = yield* failureOf(
        service.prepare({ ...target, revisionId: revision.revisionId }),
      );
      expect(refused.code).toBe("workspace_local_override");
      expect(refused.detail).toContain("src/main.ts");
      expect(yield* readText(root, "src/main.ts")).toBe("local override\n");
      expect((yield* service.inspect(target)).status).toBe("frozen");
    });

  test("leaves proposals that don't change a hidden file alone", function* (service, root) {
    yield* git(root, ["update-index", "--skip-worktree", "--", "src/main.ts"]);
    yield* git(root, ["update-index", "--assume-unchanged", "--", "docs/guide.md"]);
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(handle.cwd, "..notes/plan.md"), "worker\n");
    yield* integrate(service, handle);
    expect(yield* readText(root, "..notes/plan.md")).toBe("worker\n");
  });

  for (const [bit, flag] of hiding)
    test(`refuses to integrate once a changed file is marked ${bit}`, function* (service, root) {
      const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
      yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
      const target = workspaceTarget(handle);
      const revision = yield* service.freeze(target);
      const preparation = yield* service.prepare({ ...target, revisionId: revision.revisionId });
      yield* git(root, ["update-index", flag, "--", "src/main.ts"]);
      yield* writeFile(path.join(root, "src/main.ts"), "local override\n");
      const refused = yield* failureOf(
        service.integrate({
          ...target,
          revisionId: revision.revisionId,
          preparationId: preparation.preparationId,
        }),
      );
      expect(refused.code).toBe("workspace_local_override");
      expect(refused.detail).toContain("src/main.ts");
      expect(yield* readText(root, "src/main.ts")).toBe("local override\n");
    });
});

describe("source checkouts", () => {
  test("refuses a sparse checkout until sparse checkout is disabled", function* (service, root) {
    yield* git(root, ["sparse-checkout", "set", "src"]);
    const refused = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(refused.detail).toContain(root);
    expect(yield* worktrees(root)).toEqual([root]);

    yield* git(root, ["sparse-checkout", "disable"]);
    // Disabling keeps the pattern file; only the setting decides.
    expect(yield* exists(path.join(root, ".git", "info", "sparse-checkout"))).toBe(true);
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* exists(path.join(handle.cwd, "docs/guide.md"))).toBe(true);
  });

  test("accepts a session directory whose name starts with two dots", function* (service, root) {
    const handle = yield* service.create({
      sourceCwd: path.join(root, "..notes"),
      ownerId: "parent",
    });
    expect(path.basename(handle.cwd)).toBe("..notes");
    expect(yield* exists(path.join(handle.cwd, "plan.md"))).toBe(true);
  });

  test("names the directory when the source isn't a usable checkout", function* (service, root) {
    const parent = path.dirname(root);
    const bare = path.join(parent, "bare.git");
    yield* git(parent, ["init", "--bare", "--template=", bare]);
    const empty = path.join(parent, "empty");
    yield* io(() => fs.mkdir(empty));
    yield* git(empty, ["init", "--template="]);
    const plain = path.join(parent, "plain");
    yield* io(() => fs.mkdir(plain));
    for (const directory of [bare, empty, plain, path.join(root, ".git")]) {
      const refused = yield* failureOf(service.create({ sourceCwd: directory, ownerId: "parent" }));
      expect(refused.detail).toContain(directory);
    }
  });

  test("works from a linked worktree, publishing into it", function* (service, root) {
    const linked = path.join(path.dirname(root), "linked");
    yield* git(root, ["worktree", "add", "-q", "-b", "feature", linked]);
    yield* writeFile(path.join(linked, "docs/guide.md"), "linked edit\n");
    const handle = yield* service.create({ sourceCwd: linked, ownerId: "parent" });
    expect(handle.sourceRoot).toBe(linked);
    expect(yield* readText(handle.cwd, "docs/guide.md")).toBe("linked edit\n");
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
    yield* integrate(service, handle);
    expect(yield* readText(linked, "src/main.ts")).toBe("worker\n");
    expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
    expect(yield* worktrees(root)).toEqual([root, linked]);
    expect(yield* git(linked, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature\n");
  });
});

it.live(
  "works in a SHA-256 repository",
  () =>
    Effect.gen(function* () {
      const temporary = yield* temporaryDirectory("pi-sha256-");
      const root = path.join(temporary, "source");
      const agent = path.join(temporary, "agent");
      yield* io(() => fs.mkdir(agent, { mode: 0o700 }));
      yield* io(() => fs.mkdir(path.join(root, "src"), { recursive: true }));
      yield* git(root, ["init", "--template=", "--object-format=sha256"]);
      yield* writeFile(path.join(root, "src/a.ts"), "a\nb\nc\n");
      yield* writeFile(path.join(root, "src/gone.ts"), "gone\n");
      yield* git(root, ["add", "--", "src"]);
      yield* git(root, ["commit", "-q", "-m", "fixture"]);
      yield* Effect.gen(function* () {
        const service = yield* WorkspaceService;
        const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
        const target = workspaceTarget(handle);
        yield* writeFile(path.join(handle.cwd, "src/a.ts"), "a\nworker\nc\n");
        yield* writeFile(path.join(handle.cwd, "src/new.ts"), "new\n");
        yield* io(() => fs.unlink(path.join(handle.cwd, "src/gone.ts")));
        const revision = yield* service.freeze(target);
        expect(revision.revisionId).toMatch(/^[a-f0-9]{64}$/u);
        // A partial apply advances the baseline, removing a deleted path from it.
        const partial = yield* service.prepare({
          ...target,
          revisionId: revision.revisionId,
          paths: ["src/gone.ts", "src/new.ts"],
        });
        yield* service.integrate({
          ...target,
          revisionId: revision.revisionId,
          preparationId: partial.preparationId,
        });
        expect((yield* service.freeze(target)).changedPaths).toEqual(["src/a.ts"]);
        yield* writeFile(path.join(root, "src/a.ts"), "a\nb\nc\nparent\n");
        expect((yield* service.rebase(target)).conflictedPaths).toEqual([]);
        yield* integrate(service, handle);
        expect(yield* readText(root, "src/a.ts")).toBe("a\nworker\nc\nparent\n");
        expect(yield* readText(root, "src/new.ts")).toBe("new\n");
        expect(yield* exists(path.join(root, "src/gone.ts"))).toBe(false);
      }).pipe(Effect.provide(WorkspaceService.layer({ agentDirectory: agent })));
    }),
  60_000,
);

// Moves the file's times forward so Git must refresh its stat data in the index.
const touchLater = (file: string) =>
  io(() => fs.stat(file)).pipe(
    Effect.map((stat) => stat.mtimeMs / 1000 + 60),
    Effect.flatMap((seconds) => io(() => fs.utimes(file, seconds, seconds))),
  );

describe("source index identity", () => {
  it.live("ignores stat refreshes but detects every staging change", () =>
    Effect.gen(function* () {
      const root = path.join(yield* temporaryDirectory("pi-identity-"), "source");
      yield* commitRepository(root, [
        ["src/main.ts", "baseline\n"],
        ["src/other.ts", "other\n"],
      ]);
      const index = path.join(root, ".git", "index");
      const original = yield* sourceIdentity(root);
      const bytes = yield* io(() => fs.readFile(index));
      yield* touchLater(path.join(root, "src/main.ts"));
      yield* git(root, ["update-index", "--refresh"]);
      expect(yield* io(() => fs.readFile(index))).not.toEqual(bytes);
      expect(yield* sourceIdentity(root)).toEqual(original);

      const staged: Array<string> = [];
      for (const change of [
        ["update-index", "--chmod=+x", "--", "src/main.ts"],
        ["rm", "--cached", "-q", "--", "src/other.ts"],
      ]) {
        yield* git(root, change);
        staged.push((yield* sourceIdentity(root)).index);
      }
      yield* writeFile(path.join(root, "src/main.ts"), "changed\n");
      yield* git(root, ["add", "--", "src/main.ts"]);
      staged.push((yield* sourceIdentity(root)).index);
      expect(new Set([original.index, ...staged]).size).toBe(4);
    }),
  );

  test("integrates after the parent's index is only refreshed", function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    yield* touchLater(path.join(root, "docs/guide.md"));
    yield* git(root, ["update-index", "--refresh"]);
    yield* service.integrate({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    });
    expect(yield* readText(root, "src/main.ts")).toBe("worker\n");
  });
});
