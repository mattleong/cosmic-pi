import { afterAll, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as os from "node:os";
import { git } from "../../src/boundary/git-worktree-process.ts";
import { sourceIdentity } from "../../src/boundary/git-worktree-snapshot.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import {
  commitRepository,
  exists,
  failureOf,
  io,
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
const globalIgnore = (rules: string) =>
  Effect.gen(function* () {
    const file = path.join(home, "global-ignore");
    yield* writeFile(file, rules);
    yield* userConfig(`[core]\n\texcludesFile = ${file}\n`);
    return file;
  });
const unreadable = (file: string) => io(() => fs.chmod(file, 0o000));
// Root reads files regardless of their mode, so unreadable-file checks can't fail for it.
const runsAsRoot = process.getuid?.() === 0;

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["docs/guide.md", "guide\n"],
  ["..notes/plan.md", "plan\n"],
]);

describe("ignore rules", () => {
  test("follows include directives in the user's global configuration", function* (service, root) {
    const included = path.join(home, "included.conf");
    yield* writeFile(included, `[core]\n\texcludesFile = ${path.join(home, "global-ignore")}\n`);
    yield* writeFile(path.join(home, "global-ignore"), "global-only.md\n");
    yield* userConfig(`[include]\n\tpath = ${included}\n`);
    yield* writeFile(path.join(root, "global-only.md"), "private\n");
    yield* writeFile(path.join(root, "notes.md"), "shared\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* exists(path.join(handle.cwd, "notes.md"))).toBe(true);
    expect(yield* exists(path.join(handle.cwd, "global-only.md"))).toBe(false);
  });

  test("lets the repository's own excludes file outrank the global one in every tree", function* (service, root) {
    yield* globalIgnore("global-only.md\n");
    const local = path.join(path.dirname(root), "local-ignore");
    yield* writeFile(local, "local-only.md\n");
    yield* git(root, ["config", "core.excludesFile", local]);
    yield* writeFile(path.join(root, "global-only.md"), "global\n");
    yield* writeFile(path.join(root, "local-only.md"), "local\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* exists(path.join(handle.cwd, "local-only.md"))).toBe(false);
    expect(yield* exists(path.join(handle.cwd, "global-only.md"))).toBe(true);

    yield* writeFile(path.join(handle.cwd, "local-only.md"), "worker\n");
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "changed\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    expect(revision.changedPaths).toEqual(["src/main.ts"]);
  });

  test("refuses an ignore file Git can't read, naming it", function* (service, root) {
    if (runsAsRoot) return;
    const file = yield* globalIgnore("private.md\n");
    yield* unreadable(file);
    const refused = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(refused.detail).toContain(file);
    expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });

    yield* io(() => fs.chmod(file, 0o600));
    const exclude = path.join(root, ".git", "info", "exclude");
    yield* io(() => fs.mkdir(path.dirname(exclude), { recursive: true }));
    yield* writeFile(exclude, "scratch.md\n");
    yield* unreadable(exclude);
    expect(
      (yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }))).detail,
    ).toContain(exclude);

    yield* io(() => fs.chmod(exclude, 0o600));
    yield* service.create({ sourceCwd: root, ownerId: "parent" });
  });

  test("applies the source's info/exclude to worker captures and setup checks", function* (service, root) {
    yield* userConfig("");
    const exclude = path.join(root, ".git", "info", "exclude");
    yield* io(() => fs.mkdir(path.dirname(exclude), { recursive: true }));
    yield* writeFile(exclude, "scratch.md\n");
    yield* writeFile(path.join(root, "scratch.md"), "source scratch\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* exists(path.join(handle.cwd, "scratch.md"))).toBe(false);

    yield* writeFile(path.join(handle.cwd, "scratch.md"), "setup output\n");
    expect(yield* service.setupChanges(workspaceTarget(handle))).toEqual([]);
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "changed\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    expect(revision.changedPaths).toEqual(["src/main.ts"]);
  });
});

describe("source checkouts", () => {
  test("refuses a sparse checkout until sparse checkout is disabled", function* (service, root) {
    yield* git(root, ["sparse-checkout", "set", "src"]);
    const refused = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(refused.detail).toContain(root);

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
    for (const directory of [bare, empty, plain]) {
      const refused = yield* failureOf(service.create({ sourceCwd: directory, ownerId: "parent" }));
      expect(refused.detail).toContain(directory);
    }
  });
});

const linked = workspaceTests([
  ["AGENTS.md", "agents\n"],
  ["docs/guide.md", "guide\n"],
  ["lib/util.ts", "export const util = 1;\n"],
]);

const commitLink = (root: string, link: string, target: string) =>
  Effect.gen(function* () {
    yield* io(() => fs.mkdir(path.dirname(path.join(root, link)), { recursive: true }));
    yield* io(() => fs.symlink(target, path.join(root, link)));
    yield* git(root, ["add", "--", link]);
    yield* git(root, ["commit", "-m", "link"]);
  });

describe("unsupported files", () => {
  linked("names a tracked link whose target file is missing", function* (service, root) {
    yield* commitLink(root, "CLAUDE.md", "AGENTS.md");
    yield* io(() => fs.unlink(path.join(root, "AGENTS.md")));
    const refused = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(refused.detail).toContain('"CLAUDE.md"');
  });

  linked("names a tracked link whose target directory is missing", function* (service, root) {
    yield* commitLink(root, "notes/guide.md", "../docs/guide.md");
    yield* io(() => fs.rm(path.join(root, "docs"), { recursive: true }));
    const refused = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(refused.detail).toContain('"notes/guide.md"');
  });

  linked("names a directory that a symlink replaced", function* (service, root) {
    yield* io(() => fs.rename(path.join(root, "lib"), path.join(root, "lib-real")));
    yield* io(() => fs.symlink("lib-real", path.join(root, "lib")));
    const refused = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(refused.detail).toContain(JSON.stringify(path.join(root, "lib")));
  });
});

const cased = workspaceTests([["src/Widget.ts", "export const widget = 1;\n"]]);

cased("never silently drops a case-only rename", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* io(() =>
    fs.rename(path.join(handle.cwd, "src/Widget.ts"), path.join(handle.cwd, "src/widget.ts")),
  );
  const caseInsensitive = yield* exists(path.join(handle.cwd, "src/Widget.ts"));
  if (caseInsensitive) {
    const refused = yield* failureOf(service.freeze(workspaceTarget(handle)));
    expect(refused.detail).toContain('"src/Widget.ts"');
  } else {
    const revision = yield* service.freeze(workspaceTarget(handle));
    expect(revision.changedPaths).toEqual(["src/Widget.ts", "src/widget.ts"]);
  }
});

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
    expect(yield* io(() => fs.readFile(path.join(root, "src/main.ts"), "utf8"))).toBe("worker\n");
  });
});
