// Test harness boundary: real Node filesystem and process primitives exercise tool safety.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as NodePath from "@effect/platform-node/NodePath";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vitest";
import {
  ADVISOR_TOOL_LIMITS,
  AdvisorToolSafetyError,
  createAdvisorToolsEffect,
} from "../src/runtime/tools.ts";
import { provideBuiltLayer } from "pi-cosmic-core";
import { _readOnlyFileSystemTest, ReadOnlyFileSystem } from "../src/boundary/read-only-fs.ts";
import { advisorPlatformLayer } from "../src/boundary/executor.ts";
import { makeStandaloneAdvisorExecutor, standaloneAdvisorExecutor } from "./support/executor.ts";
import { nodeChildProcess, nodeFsPromises, nodePath } from "./support/node-builtins.ts";

const { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } = nodeFsPromises;
const { join, win32 } = nodePath;

const directories: string[] = [];

const fixture = () =>
  Effect.promise(() =>
    mkdtemp(join(tmpdir(), "pi-advisor-tools-")).then((root) => {
      directories.push(root);
      return mkdir(join(root, "src"))
        .then(() =>
          writeFile(join(root, "src", "a.ts"), "export const answer = 42;\nsecond line\n"),
        )
        .then(() => writeFile(join(root, "README.md"), "answer documentation\n"))
        .then(() => root);
    }),
  );

const tempDir = (prefix: string) =>
  Effect.promise(() =>
    mkdtemp(join(tmpdir(), prefix)).then((directory) => {
      directories.push(directory);
      return directory;
    }),
  );

const toolsFor = (root: string, executor = standaloneAdvisorExecutor) =>
  createAdvisorToolsEffect(root, executor).pipe(provideBuiltLayer(advisorPlatformLayer));

const executePromise = <ParamsInput>(
  tools: Effect.Success<ReturnType<typeof toolsFor>>,
  name: string,
  params: ParamsInput,
) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return Promise.reject(new Error(`missing ${name}`));
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  return tool.execute("call", params as never, undefined, undefined, {} as never);
};

const execute = <ParamsInput>(root: string, name: string, params: ParamsInput) =>
  toolsFor(root).pipe(
    Effect.flatMap((tools) => Effect.promise(() => executePromise(tools, name, params))),
  );

const executeRejects = <ParamsInput>(
  root: string,
  name: string,
  params: ParamsInput,
  matcher?: RegExp | typeof AdvisorToolSafetyError,
) =>
  toolsFor(root).pipe(
    Effect.flatMap((tools) =>
      Effect.promise(() =>
        matcher === undefined
          ? expect(executePromise(tools, name, params)).rejects.toThrow()
          : expect(executePromise(tools, name, params)).rejects.toThrow(matcher),
      ),
    ),
  );

function resultText(result: Awaited<ReturnType<typeof executePromise>>): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}

const digest = (root: string) =>
  Effect.promise(() => {
    const hash = createHash("sha256");
    return ["README.md", "src/a.ts"]
      .reduce(
        (chain, path) =>
          chain.then(() => readFile(join(root, path))).then((bytes) => void hash.update(bytes)),
        Promise.resolve(),
      )
      .then(() => hash.digest("hex"));
  });

afterEach(() => {
  vi.restoreAllMocks();
  return Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ).then(() => undefined);
});

describe("package-owned Advisor tools", () => {
  it.effect("uses platform-relative containment for Windows paths", () =>
    Effect.sync(() => {
      expect(
        _readOnlyFileSystemTest.isContainedPathWith(
          win32,
          "C:\\project",
          "C:\\project\\src\\file.ts",
        ),
      ).toBe(true);
      expect(
        _readOnlyFileSystemTest.isContainedPathWith(
          win32,
          "C:\\project",
          "C:\\project-sibling\\secret.txt",
        ),
      ).toBe(false);
    }),
  );

  it.effect("filters outside-only names after a directory swap and restore", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const scan = join(root, "scan");
      const outside = yield* tempDir("pi-advisor-directory-swap-");
      yield* Effect.promise(() =>
        mkdir(scan)
          .then(() => writeFile(join(scan, "inside.txt"), "inside"))
          .then(() => writeFile(join(outside, "outside-only-secret.txt"), "outside")),
      );
      const saved = `${scan}-saved`;
      let beforeOpenCalls = 0;
      let afterReadCalls = 0;
      const readOnlyFileSystem = ReadOnlyFileSystem.layerWith({
        beforeOpen: (path) => {
          beforeOpenCalls += 1;
          return rename(path, saved).then(() => symlink(outside, path, "dir"));
        },
        afterRead: (path) => {
          afterReadCalls += 1;
          return rm(path).then(() => rename(saved, path));
        },
      }).pipe(Layer.provide(NodePath.layer));
      const tools = yield* toolsFor(root, makeStandaloneAdvisorExecutor(readOnlyFileSystem));
      const result = yield* Effect.promise(() => executePromise(tools, "ls", { path: "scan" }));
      expect(resultText(result)).not.toContain("outside-only-secret.txt");
      expect(beforeOpenCalls).toBe(1);
      expect(afterReadCalls).toBe(1);
    }),
  );

  it.effect("rejects a pinned project root replaced by an outside symlink", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const tools = yield* toolsFor(root);
      const moved = `${root}-moved`;
      const outside = yield* tempDir("pi-advisor-outside-");
      directories.push(moved);
      yield* Effect.promise(() =>
        writeFile(join(outside, "secret.txt"), "outside secret")
          .then(() => rename(root, moved))
          .then(() => symlink(outside, root, "dir")),
      );
      const read = tools.find((tool) => tool.name === "read");
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* Effect.promise(() =>
        expect(
          read?.execute("call", { path: "secret.txt" }, undefined, undefined, {} as never),
        ).rejects.toThrow(/root|exist|escape|project/i),
      );
    }),
  );

  it.effect("treats an in-root hard-link directory entry as an in-root file", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const outside = yield* tempDir("pi-advisor-hardlink-");
      const source = join(outside, "source.txt");
      yield* Effect.promise(() =>
        writeFile(source, "hard-link content").then(() => link(source, join(root, "linked.txt"))),
      );
      expect(resultText(yield* execute(root, "read", { path: "linked.txt" }))).toContain(
        "hard-link content",
      );
    }),
  );

  it.effect("inspects a project through all four tools without mutation", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const before = yield* digest(root);
      expect(resultText(yield* execute(root, "read", { path: "src/a.ts" }))).toContain(
        "answer = 42",
      );
      expect(resultText(yield* execute(root, "grep", { path: ".", pattern: "answer" }))).toContain(
        "src/a.ts:1",
      );
      expect(resultText(yield* execute(root, "find", { path: ".", pattern: "**" }))).toContain(
        "README.md",
      );
      expect(resultText(yield* execute(root, "ls", { path: "." }))).toContain("src/");
      expect(yield* digest(root)).toBe(before);
    }),
  );

  it.effect("rejects traversal, outside absolute paths, and escaping symlinks", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const outside = yield* tempDir("pi-advisor-outside-");
      yield* Effect.promise(() =>
        writeFile(join(outside, "secret"), "secret").then(() =>
          symlink(join(outside, "secret"), join(root, "escape")),
        ),
      );
      for (const path of ["../outside", join(outside, "secret"), "escape"]) {
        yield* executeRejects(root, "read", { path }, AdvisorToolSafetyError);
      }
    }),
  );

  it.effect("treats grep patterns literally and cannot execute catastrophic JavaScript regex", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      yield* Effect.promise(() =>
        writeFile(join(root, "redos.txt"), `${"a".repeat(100_000)}!\n(a+)+$\n`),
      );
      const started = performance.now();
      const result = yield* execute(root, "grep", { path: ".", pattern: "(a+)+$" });
      expect(resultText(result)).toContain("redos.txt:2");
      expect(performance.now() - started).toBeLessThan(1_000);
    }),
  );

  it.effect("matches **/*.ts at both project root and nested paths", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      yield* Effect.promise(() => writeFile(join(root, "root.ts"), "root\n"));
      const text = resultText(yield* execute(root, "find", { path: ".", pattern: "**/*.ts" }));
      expect(text).toContain("root.ts");
      expect(text).toContain("src/a.ts");
      expect(text).not.toContain("README.md");
    }),
  );

  it.effect("rejects oversized path and grep pattern strings at execution boundaries", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const longPath = "a".repeat(ADVISOR_TOOL_LIMITS.maxPathChars + 1);
      yield* executeRejects(root, "read", { path: longPath }, AdvisorToolSafetyError);
      yield* executeRejects(
        root,
        "find",
        { path: longPath, pattern: "**" },
        AdvisorToolSafetyError,
      );
      yield* executeRejects(
        root,
        "grep",
        { path: longPath, pattern: "answer" },
        AdvisorToolSafetyError,
      );
      yield* executeRejects(root, "grep", { path: ".", pattern: longPath }, AdvisorToolSafetyError);
    }),
  );

  it.effect("rejects oversized find patterns without regular-expression evaluation", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      yield* executeRejects(
        root,
        "find",
        { path: ".", pattern: "*".repeat(ADVISOR_TOOL_LIMITS.maxPatternChars + 1) },
        AdvisorToolSafetyError,
      );
    }),
  );

  it.effect("glob matching stays bounded for adversarial wildcard patterns", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const pattern = `${"*a".repeat(ADVISOR_TOOL_LIMITS.maxPatternChars / 2 - 3)}*.ts`;
      const started = performance.now();
      yield* execute(root, "find", { path: ".", pattern });
      expect(performance.now() - started).toBeLessThan(1_000);
    }),
  );

  it.effect("does not follow symlinked directories during recursive grep or find", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const outside = yield* tempDir("pi-advisor-outside-dir-");
      yield* Effect.promise(() =>
        writeFile(join(outside, "credential.txt"), "outside-only-secret").then(() =>
          symlink(outside, join(root, "linked-directory")),
        ),
      );
      expect(resultText(yield* execute(root, "find", { path: ".", pattern: "**" }))).not.toContain(
        "credential.txt",
      );
      expect(
        resultText(yield* execute(root, "grep", { path: ".", pattern: "outside-only-secret" })),
      ).not.toContain("outside-only-secret");
    }),
  );

  it.effect("glob walks apply global visited-directory and entry caps", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      for (let index = 0; index < ADVISOR_TOOL_LIMITS.maxVisitedDirectories + 5; index += 1) {
        yield* Effect.promise(() =>
          mkdir(join(root, `directory-${index}`)).then(() =>
            writeFile(join(root, `directory-${index}`, "value.txt"), "bounded\n"),
          ),
        );
      }
      const result = yield* execute(root, "find", { path: ".", pattern: "**" });
      expect(resultText(result)).toContain("output truncated");
    }),
  );

  it.effect("rejects an already-aborted tool execution without opening content", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      const tools = yield* toolsFor(root);
      const read = tools.find((tool) => tool.name === "read");
      const controller = new AbortController();
      controller.abort();
      // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
      yield* Effect.promise(() =>
        expect(
          read?.execute("call", { path: "README.md" }, controller.signal, undefined, {} as never),
        ).rejects.toThrow(),
      );
    }),
  );

  it.effect("rejects FIFO reads without blocking", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return;
      const root = yield* fixture();
      const fifo = join(root, "pipe");
      const created = nodeChildProcess.spawnSync("mkfifo", [fifo]);
      expect(created.status).toBe(0);
      const started = performance.now();
      yield* executeRejects(root, "read", { path: "pipe" });
      expect(performance.now() - started).toBeLessThan(1_000);
    }),
  );

  it.effect("bounds bytes and marks oversized evidence as truncated", () =>
    Effect.gen(function* () {
      const root = yield* fixture();
      yield* Effect.promise(() =>
        writeFile(join(root, "large.txt"), "x".repeat(ADVISOR_TOOL_LIMITS.maxBytesPerFile + 50)),
      );
      const result = yield* execute(root, "read", { path: "large.txt" });
      expect(resultText(result).length).toBeLessThan(
        ADVISOR_TOOL_LIMITS.maxBytesPerFile + ADVISOR_TOOL_LIMITS.maxLines * 10,
      );
      expect(resultText(result)).toContain("output truncated");
    }),
  );

  it.effect("does not invoke guarded Node process-launch APIs during any tool operation", () =>
    Effect.gen(function* () {
      const guards = [
        vi.spyOn(nodeChildProcess, "spawn"),
        vi.spyOn(nodeChildProcess, "spawnSync"),
        vi.spyOn(nodeChildProcess, "exec"),
        vi.spyOn(nodeChildProcess, "execFile"),
        vi.spyOn(nodeChildProcess, "fork"),
      ];
      const root = yield* fixture();
      yield* execute(root, "read", { path: "README.md" });
      yield* execute(root, "grep", { path: ".", pattern: "answer" });
      yield* execute(root, "find", { path: ".", pattern: "**" });
      yield* execute(root, "ls", { path: "." });
      for (const guard of guards) expect(guard).not.toHaveBeenCalled();
    }),
  );
});
