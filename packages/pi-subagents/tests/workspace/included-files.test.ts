import { describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { git, gitResult, gitSucceeded } from "../../src/boundary/git-worktree-process.ts";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import type { WorkspaceHandle } from "../../src/workspace/model.ts";
import type { WorkspaceServiceContract } from "../../src/workspace/service.ts";
import {
  exists,
  failureOf,
  io,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

const test = workspaceTests([
  [".gitignore", ".env\n*.local\n"],
  ["src/main.ts", "baseline\n"],
]);

/** Writes the checkout's `.worktreeinclude`. */
const includeFile = (root: string, text: string) =>
  writeFile(path.join(root, ".worktreeinclude"), text);

const permissions = (...parts: ReadonlyArray<string>) =>
  io(() => fs.lstat(path.join(...parts))).pipe(Effect.map((stat) => stat.mode & 0o777));

/** Whether the repository holds a blob with exactly `content`. */
const holdsBlob = (root: string, content: string) =>
  Effect.gen(function* () {
    const id = (yield* git(root, ["hash-object", "--stdin"], {
      stdin: new TextEncoder().encode(content),
    })).trim();
    return gitSucceeded(yield* gitResult(root, ["cat-file", "-e", id]));
  });

const prepareAndIntegrate = (service: WorkspaceServiceContract, handle: WorkspaceHandle) =>
  Effect.gen(function* () {
    const target = workspaceTarget(handle);
    const revision = yield* service.freeze(target);
    const preparation = yield* service.prepare({ ...target, revisionId: revision.revisionId });
    return { revision, preparation };
  });

describe(".worktreeinclude", () => {
  test("copies matching ignored files with their mode into the worker and test trees", function* (service, root) {
    yield* writeFile(path.join(root, ".env"), "TOKEN=parent\n");
    yield* io(() => fs.chmod(path.join(root, ".env"), 0o640));
    yield* io(() => fs.mkdir(path.join(root, "config")));
    yield* writeFile(path.join(root, "config/db.local"), "db\n");
    yield* io(() => fs.chmod(path.join(root, "config/db.local"), 0o750));
    // Ignored but unmatched, so it stays out like any ignored file.
    yield* writeFile(path.join(root, "other.local"), "other\n");
    yield* includeFile(root, "# Local files writers need\n\n.env\n  \n# other.local\nconfig/   \n");

    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* readText(handle.cwd, ".env")).toBe("TOKEN=parent\n");
    expect(yield* permissions(handle.cwd, ".env")).toBe(0o640);
    expect(yield* permissions(handle.cwd, "config/db.local")).toBe(0o750);
    expect(yield* exists(path.join(handle.cwd, "other.local"))).toBe(false);
    expect((yield* service.inspect(workspaceTarget(handle))).includedPaths).toEqual([
      ".env",
      "config/db.local",
    ]);

    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "edited\n");
    const { revision, preparation } = yield* prepareAndIntegrate(service, handle);
    expect(revision.changedPaths).toEqual(["src/main.ts"]);
    expect(yield* readText(preparation.cwd, ".env")).toBe("TOKEN=parent\n");
    expect(yield* permissions(preparation.cwd, ".env")).toBe(0o640);
    expect(yield* permissions(preparation.cwd, "config/db.local")).toBe(0o750);

    const integration = yield* service.integrate({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: preparation.preparationId,
    });
    expect(integration.record.status).toBe("integrated");
    expect(yield* readText(root, "src/main.ts")).toBe("edited\n");
    expect(yield* readText(root, ".env")).toBe("TOKEN=parent\n");
  });

  test("never captures an included file, even edited, un-ignored, or staged", function* (service, root) {
    yield* writeFile(path.join(root, ".env"), "TOKEN=parent\n");
    yield* includeFile(root, ".env\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    const target = workspaceTarget(handle);

    yield* writeFile(path.join(handle.cwd, ".env"), "TOKEN=writer-secret\n");
    yield* writeFile(path.join(handle.cwd, ".gitignore"), "*.local\n");
    const unignored = yield* service.freeze(target);
    expect(unignored.changedPaths).toEqual([".gitignore"]);
    expect(unignored.diff).not.toContain("TOKEN");
    expect(yield* holdsBlob(root, "TOKEN=writer-secret\n")).toBe(false);

    yield* service.revise(target);
    yield* git(handle.cwd, ["add", "--", ".env"]);
    yield* writeFile(path.join(handle.cwd, ".env"), "TOKEN=later-secret\n");
    const staged = yield* service.freeze(target);
    expect(staged.changedPaths).toEqual([".gitignore"]);
    expect(staged.diff).not.toContain("TOKEN");
    expect(yield* holdsBlob(root, "TOKEN=later-secret\n")).toBe(false);
    expect((yield* service.inspect(target)).includedPaths).toEqual([".env"]);
  });

  test("includes credential-named untracked files the baseline leaves out, never tracked or captured ones", function* (service, root) {
    yield* writeFile(path.join(root, "credentials.json"), '{"key":"secret"}\n');
    // Untracked and not ignored: the baseline already carries it.
    yield* writeFile(path.join(root, "notes.md"), "notes\n");
    yield* includeFile(root, "credentials.json\nnotes.md\nsrc/main.ts\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* readText(handle.cwd, "credentials.json")).toBe('{"key":"secret"}\n');
    expect((yield* service.inspect(workspaceTarget(handle))).includedPaths).toEqual([
      "credentials.json",
    ]);
    const revision = yield* service.freeze(workspaceTarget(handle));
    expect(revision.changedPaths).toEqual([]);
    expect(revision.uncapturedPaths).toBeUndefined();
  });

  test("skips symlinks a pattern matches", function* (service, root) {
    yield* writeFile(path.join(root, ".env"), "TOKEN=parent\n");
    yield* io(() => fs.symlink("/etc/hosts", path.join(root, "hosts.local")));
    yield* includeFile(root, ".env\n*.local\n");
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* exists(path.join(handle.cwd, ".env"))).toBe(true);
    expect(
      yield* io(() =>
        fs.lstat(path.join(handle.cwd, "hosts.local")).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
    expect((yield* service.inspect(workspaceTarget(handle))).includedPaths).toEqual([".env"]);
  });

  test("refuses more files than the cap before creating anything", function* (service, root, agent) {
    yield* io(() => fs.mkdir(path.join(root, "many")));
    for (let index = 0; index <= 256; index += 1)
      yield* writeFile(path.join(root, "many", `${index}.local`), `${index}\n`);
    yield* includeFile(root, "many/\n");
    const error = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(error.operation).toBe("create");
    const left = yield* io(() => fs.readdir(path.join(agent, "subagent-worktrees")));
    expect(left.filter((name) => /^[a-f0-9-]{36}$/u.test(name))).toEqual([]);
  });

  test("refuses more bytes than the cap", function* (service, root) {
    const large = path.join(root, "large.local");
    yield* writeFile(large, "");
    yield* io(() => fs.truncate(large, 64 * 1024 * 1024 + 1));
    yield* includeFile(root, "*.local\n");
    const error = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
    expect(error.operation).toBe("create");
  });

  test("gives a nested writer the source worker's included files without capturing them", function* (service, root) {
    // A credential-named source file is captured from private trees, so only the include rule
    // keeps the parent's copy out of the nested baseline.
    yield* writeFile(path.join(root, "secrets.ts"), "export const key = 'parent';\n");
    yield* writeFile(path.join(root, ".env"), "TOKEN=parent\n");
    yield* includeFile(root, ".env\nsecrets.ts\n");
    const parent = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(parent.cwd, "secrets.ts"), "export const key = 'worker';\n");
    yield* writeFile(path.join(parent.cwd, ".env"), "TOKEN=worker\n");

    const child = yield* service.create({
      sourceCwd: parent.cwd,
      ownerId: "parent/child",
      sourceWorkspace: { workspaceId: parent.workspaceId, ownerId: parent.ownerId },
    });
    expect(yield* readText(child.cwd, ".env")).toBe("TOKEN=worker\n");
    expect(yield* readText(child.cwd, "secrets.ts")).toBe("export const key = 'worker';\n");
    expect(yield* holdsBlob(root, "export const key = 'worker';\n")).toBe(false);
    expect((yield* service.inspect(workspaceTarget(child))).includedPaths).toEqual([
      ".env",
      "secrets.ts",
    ]);
    yield* writeFile(path.join(child.cwd, "src/main.ts"), "child edit\n");
    expect((yield* service.freeze(workspaceTarget(child))).changedPaths).toEqual(["src/main.ts"]);
    expect((yield* service.freeze(workspaceTarget(parent))).changedPaths).toEqual([]);
  });

  test("includes nothing without the file and refuses one it can't use", function* (service, root) {
    yield* writeFile(path.join(root, ".env"), "TOKEN=parent\n");
    const plain = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* exists(path.join(plain.cwd, ".env"))).toBe(false);
    expect((yield* service.inspect(workspaceTarget(plain))).includedPaths).toBeUndefined();

    yield* includeFile(root, Array.from({ length: 65 }, (_, index) => `file-${index}`).join("\n"));
    expect(
      (yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }))).operation,
    ).toBe("create");
    yield* io(() => fs.rm(path.join(root, ".worktreeinclude")));
    yield* io(() => fs.symlink(path.join(root, ".env"), path.join(root, ".worktreeinclude")));
    expect(
      (yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }))).operation,
    ).toBe("create");
  });
});
