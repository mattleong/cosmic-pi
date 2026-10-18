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

test("scans only the lines an edit adds to an indexed file, naming the line", function* (service, root) {
  const fixture = path.join(root, "tests/fixture.test.ts");
  yield* writeFile(fixture, `// An unrelated edit.\n${fixtureTest}const extra = 1;\n`);
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* readText(handle.cwd, "tests/fixture.test.ts")).toContain("An unrelated edit");
  yield* service.discard(workspaceTarget(handle));

  yield* writeFile(fixture, `${fixtureTest}const extra = 1;\nconst leaked = "${githubToken}";\n`);
  const refused = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
  expect(refused.detail).toContain('"tests/fixture.test.ts"');
  expect(refused.detail).toContain("a GitHub token (line 4)");

  // A second copy of a line the index already holds is an added line too.
  yield* writeFile(
    fixture,
    `${fixtureTest}const again = "${apiKey}";\nconst token = "${apiKey}";\n`,
  );
  const copied = yield* failureOf(service.create({ sourceCwd: root, ownerId: "parent" }));
  expect(copied.detail).toContain("an sk- API key (line 3)");
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

const named = workspaceTests([
  ["scripts/build", "#!/bin/sh\necho build\n"],
  ["build/output.js", "output\n"],
  ["store/index.js", "store\n"],
]);

named("omits dependency directories, not files that share their names", function* (service, root) {
  yield* io(() => fs.symlink("store", path.join(root, "node_modules")));
  yield* git(root, ["add", "--", "node_modules"]);
  const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
  expect(yield* readText(handle.cwd, "scripts/build")).toContain("echo build");
  expect(handle.omittedTrackedPaths).toEqual(["build/output.js", "node_modules"]);
  expect(yield* exists(path.join(handle.cwd, "node_modules"))).toBe(false);
});

// "café\n" in Latin-1: text without a NUL byte that isn't UTF-8.
const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
const legacy = workspaceTests([
  ["src/main.ts", "baseline\n"],
  ["docs/legacy.txt", latin1],
]);

legacy(
  "captures unchanged text that isn't UTF-8, refusing only a change to it",
  function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    expect(yield* io(() => fs.readFile(path.join(handle.cwd, "docs/legacy.txt")))).toEqual(
      Buffer.from(latin1),
    );
    yield* writeFile(path.join(handle.cwd, "src/main.ts"), "worker\n");
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
    expect(yield* readText(root, "src/main.ts")).toBe("worker\n");

    const edited = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(
      path.join(edited.cwd, "docs/legacy.txt"),
      new Uint8Array([...latin1, 0x6e, 0xe9, 0x0a]),
    );
    const refused = yield* failureOf(service.freeze(workspaceTarget(edited)));
    expect(refused.detail).toContain('"docs/legacy.txt"');
    expect((yield* service.inspect(workspaceTarget(edited))).status).toBe("active");
  },
);

// Git sorts a directory as if its name ended in "/", after "a-b.ts" and "a.ts" but before "a0.ts".
const ordered = workspaceTests([
  ["a.ts", "dot\n"],
  ["a/b.ts", "nested\n"],
  ["a-b.ts", "dash\n"],
  ["a0.ts", "digit\n"],
  ["a b.ts", "space\n"],
]);

ordered(
  "verifies trees whose entry order depends on Git's directory rule",
  function* (service, root) {
    const handle = yield* service.create({ sourceCwd: root, ownerId: "parent" });
    yield* writeFile(path.join(handle.cwd, "a/b.ts"), "worker\n");
    expect(yield* service.inspectWorkerChanges(workspaceTarget(handle))).toMatchObject({
      changedPaths: ["a/b.ts"],
      uncapturedPaths: [],
    });
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
    expect(yield* readText(root, "a/b.ts")).toBe("worker\n");
  },
);
