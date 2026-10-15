import { expect } from "vitest";
import { nodeFsPromises as fs, nodePath as path } from "../../src/boundary/node-builtins.ts";
import { git } from "../../src/boundary/git-worktree-process.ts";
import {
  exists,
  failureOf,
  io,
  readText,
  workspaceTarget,
  workspaceTests,
  writeFile,
} from "./fixtures/repository.ts";

// Built at runtime so this file never holds a literal the policy would flag.
const privateKeyBlock = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
const apiKey = ["sk", "fixture0123456789abcdefghij"].join("-");
const githubToken = ["ghp", "A".repeat(36)].join("_");

const fixtureTest = `const key = "${privateKeyBlock}";\nconst token = "${apiKey}";\n`;

const test = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["src/warnings/secrets.ts", "export const secretRules = [];\n"],
  ["tests/fixture.test.ts", fixtureTest],
  ["vendor/lib.go", "package lib\n"],
  ["packages/app/dist/bundle.js", "bundle\n"],
  [".gitignore", "ignored.ts\n"],
]);

test("copies tracked credential-named source and committed fixtures, but not dependency directories", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* readText(handle.cwd, "src/warnings/secrets.ts")).toBe(
    "export const secretRules = [];\n",
  );
  expect(yield* readText(handle.cwd, "tests/fixture.test.ts")).toBe(fixtureTest);
  expect(yield* exists(path.join(handle.cwd, "vendor/lib.go"))).toBe(false);
  expect(handle.omittedTrackedPaths).toEqual(["packages/app/dist/bundle.js", "vendor/lib.go"]);
  expect((yield* service.inspect(workspaceTarget(handle))).handle.omittedTrackedPaths).toEqual(
    handle.omittedTrackedPaths,
  );
});

test("refuses unstaged credential content, naming its path, and accepts it once staged", function* (service, root) {
  yield* writeFile(path.join(root, "src/leak.ts"), `export const token = "${githubToken}";\n`);
  const untracked = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
  expect(untracked.detail).toContain('"src/leak.ts"');
  expect(untracked.detail).toContain("line 1");
  yield* io(() => fs.unlink(path.join(root, "src/leak.ts")));

  const fixture = path.join(root, "tests/fixture.test.ts");
  yield* writeFile(fixture, `${fixtureTest}const aws = "AKIA${"B".repeat(16)}";\n`);
  const unstaged = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
  expect(unstaged.detail).toContain('"tests/fixture.test.ts"');
  expect(yield* service.listAll).toEqual({ records: [], unavailable: [] });

  yield* git(root, ["add", "--", "tests/fixture.test.ts"]);
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* readText(handle.cwd, "tests/fixture.test.ts")).toContain("AKIA");
});

test("scans the parent again at prepare, but never worker-written content", function* (service, root) {
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  yield* writeFile(
    path.join(handle.cwd, "src/main.ts"),
    `export const token = "${githubToken}";\n`,
  );
  const revision = yield* service.freeze(workspaceTarget(handle));
  yield* writeFile(path.join(root, "src/local.ts"), `const key = "${privateKeyBlock}";\n`);
  const refused = yield* failureOf(
    service.prepare({ ...workspaceTarget(handle), revisionId: revision.revisionId }),
  );
  expect(refused.detail).toContain('"src/local.ts"');
  yield* io(() => fs.unlink(path.join(root, "src/local.ts")));
  const prepared = yield* service.prepare({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
  });
  yield* service.integrate({
    ...workspaceTarget(handle),
    revisionId: revision.revisionId,
    preparationId: prepared.preparationId,
  });
  expect(yield* readText(root, "src/main.ts")).toContain(githubToken);
});

const attributed = workspaceTests([
  ["src/id.ts", "// $Id$\nconst value = 1;\n"],
  ["notes.txt", "first\nsecond\n"],
  ["data.bin", new Uint8Array([0, 1, 13, 10, 10])],
]);

attributed(
  "keeps content byte-exact under a .gitattributes that asks for conversions",
  function* (service, root) {
    yield* writeFile(
      path.join(root, ".gitattributes"),
      "* text eol=crlf ident\n*.txt working-tree-encoding=UTF-16\n*.bin filter=missing diff=missing\n",
    );
    yield* git(root, ["add", "--", ".gitattributes"]);
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    for (const name of ["src/id.ts", "notes.txt", "data.bin", ".gitattributes"])
      expect(yield* io(() => fs.readFile(path.join(handle.cwd, name)))).toEqual(
        yield* io(() => fs.readFile(path.join(root, name))),
      );
    yield* writeFile(path.join(handle.cwd, "src/id.ts"), "// $Id$\nconst value = 2;\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    expect(revision.changedPaths).toEqual(["src/id.ts"]);
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    expect(yield* io(() => fs.readFile(path.join(prepared.cwd, "notes.txt")))).toEqual(
      Buffer.from("first\nsecond\n"),
    );
    yield* service.integrate({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    });
    expect(yield* readText(root, "src/id.ts")).toBe("// $Id$\nconst value = 2;\n");
  },
);

const linked = workspaceTests([["src/main.ts", "baseline\n"]]);

linked(
  "snapshots and integrates into a linked worktree without touching the main checkout",
  function* (service, root) {
    const worktree = path.join(path.dirname(root), "linked");
    yield* git(root, ["worktree", "add", "--detach", worktree]);
    yield* writeFile(path.join(worktree, "src/main.ts"), "linked edit\n");
    const indexPath = (yield* git(worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ])).trim();
    const index = yield* io(() => fs.readFile(indexPath));
    const handle = yield* service.create({ sourceCwd: worktree, ownerId: "parent" });
    expect(yield* readText(handle.cwd, "src/main.ts")).toBe("linked edit\n");
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker edit\n");
    const revision = yield* service.freeze(workspaceTarget(handle));
    const prepared = yield* service.prepare({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
    });
    yield* service.integrate({
      ...workspaceTarget(handle),
      revisionId: revision.revisionId,
      preparationId: prepared.preparationId,
    });
    expect(yield* readText(worktree, "src/main.ts")).toBe("worker edit\n");
    expect(yield* readText(root, "src/main.ts")).toBe("baseline\n");
    expect(yield* io(() => fs.readFile(indexPath))).toEqual(index);
  },
);

linked(
  "snapshots a checkout whose .git is a file, as submodule checkouts have",
  function* (service, root) {
    const checkout = path.join(path.dirname(root), "separate");
    const gitDirectory = path.join(path.dirname(root), "separate.git");
    yield* io(() => fs.mkdir(path.join(checkout, "src"), { recursive: true }));
    yield* git(checkout, ["init", "--template=", `--separate-git-dir=${gitDirectory}`]);
    yield* writeFile(path.join(checkout, "src/main.ts"), "separate\n");
    yield* git(checkout, ["add", "--", "src/main.ts"]);
    yield* git(checkout, ["commit", "-m", "fixture"]);
    expect((yield* io(() => fs.lstat(path.join(checkout, ".git")))).isFile()).toBe(true);
    const handle = yield* service.create({ sourceCwd: checkout, ownerId: "parent" });
    expect(yield* readText(handle.cwd, "src/main.ts")).toBe("separate\n");
  },
);

const sha256 = workspaceTests([["src/main.ts", "baseline\n"]]);

sha256("compares staged content in SHA-256 repositories", function* (service, root) {
  const source = path.join(path.dirname(root), "sha256");
  yield* io(() => fs.mkdir(path.join(source, "src"), { recursive: true }));
  yield* git(source, ["init", "--template=", "--object-format=sha256"]);
  yield* writeFile(path.join(source, "src/main.ts"), `const key = "${privateKeyBlock}";\n`);
  yield* git(source, ["add", "--", "src/main.ts"]);
  yield* git(source, ["commit", "-m", "fixture"]);
  const handle = yield* service.create({ sourceCwd: source, ownerId: "parent" });
  expect(yield* readText(handle.cwd, "src/main.ts")).toContain("PRIVATE KEY");
  yield* writeFile(
    path.join(source, "src/main.ts"),
    `const key = "${privateKeyBlock}";\n// edit\n`,
  );
  expect(
    (yield* failureOf(service.create({ sourceCwd: source, ownerId: "parent" }))).detail,
  ).toContain('"src/main.ts"');
});

sha256("names the path when a file can't be copied", function* (service, root) {
  yield* io(() => fs.link(path.join(root, "src/main.ts"), path.join(root, "src/copy.ts")));
  const failure = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
  expect(failure.detail).toContain('"src/copy.ts"');
  expect(failure.detail).toMatch(/^Path: .*\nRule: .*\nRemedy: .*$/su);
});
