// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ADVISOR_TOOL_LIMITS,
  ADVISOR_TOOL_NAMES,
  AdvisorToolSafetyError,
  createAdvisorTools,
  isPackageAdvisorTool,
} from "../src/runtime/tools.ts";
import { _readOnlyFileSystemTest } from "../src/boundary/read-only-fs.ts";

const directories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-advisor-tools-"));
  directories.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "export const answer = 42;\nsecond line\n");
  await writeFile(join(root, "README.md"), "answer documentation\n");
  return root;
}

async function execute(root: string, name: string, params: unknown) {
  const tool = (await createAdvisorTools(root)).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return await tool.execute("call", params as never, undefined, undefined, {} as never);
}

function resultText(result: Awaited<ReturnType<typeof execute>>): string {
  const content = result.content[0];
  return content?.type === "text" ? content.text : "";
}

async function digest(root: string): Promise<string> {
  const hash = createHash("sha256");
  for (const path of ["README.md", "src/a.ts"]) hash.update(await readFile(join(root, path)));
  return hash.digest("hex");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("package-owned Advisor tools", () => {
  test("uses platform-relative containment for Windows paths", () => {
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
  });

  test("filters outside-only names after a directory swap and restore", async () => {
    const root = await fixture();
    const scan = join(root, "scan");
    const outside = await mkdtemp(join(tmpdir(), "pi-advisor-directory-swap-"));
    directories.push(outside);
    await mkdir(scan);
    await writeFile(join(scan, "inside.txt"), "inside");
    await writeFile(join(outside, "outside-only-secret.txt"), "outside");
    const saved = `${scan}-saved`;
    _readOnlyFileSystemTest.setDirectoryHooks({
      beforeOpen: async (path) => {
        await rename(path, saved);
        await symlink(outside, path, "dir");
      },
      afterRead: async (path) => {
        await rm(path);
        await rename(saved, path);
      },
    });
    try {
      const result = await execute(root, "ls", { path: "scan" });
      expect(resultText(result)).not.toContain("outside-only-secret.txt");
    } finally {
      _readOnlyFileSystemTest.setDirectoryHooks();
    }
  });

  test("rejects a pinned project root replaced by an outside symlink", async () => {
    const root = await fixture();
    const tools = await createAdvisorTools(root);
    const moved = `${root}-moved`;
    const outside = await mkdtemp(join(tmpdir(), "pi-advisor-outside-"));
    directories.push(moved, outside);
    await writeFile(join(outside, "secret.txt"), "outside secret");
    await rename(root, moved);
    await symlink(outside, root, "dir");
    const read = tools.find((tool) => tool.name === "read");
    await expect(
      read?.execute("call", { path: "secret.txt" }, undefined, undefined, {} as never),
    ).rejects.toThrow(/root|exist|escape|project/i);
  });

  test("treats an in-root hard-link directory entry as an in-root file", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-advisor-hardlink-"));
    directories.push(outside);
    const source = join(outside, "source.txt");
    await writeFile(source, "hard-link content");
    await link(source, join(root, "linked.txt"));
    expect(resultText(await execute(root, "read", { path: "linked.txt" }))).toContain(
      "hard-link content",
    );
  });

  test("exposes exactly read, grep, find and ls with package identity", async () => {
    const tools = await createAdvisorTools(await fixture());
    expect(tools.map((tool) => tool.name)).toEqual(ADVISOR_TOOL_NAMES);
    expect(tools.every((tool) => isPackageAdvisorTool(tool))).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["bash", "write", "edit", "patch", "exec", "custom", "all"]),
    );
  });

  test("inspects a project through all four tools without mutation", async () => {
    const root = await fixture();
    const before = await digest(root);
    expect(resultText(await execute(root, "read", { path: "src/a.ts" }))).toContain("answer = 42");
    expect(resultText(await execute(root, "grep", { path: ".", pattern: "answer" }))).toContain(
      "src/a.ts:1",
    );
    expect(resultText(await execute(root, "find", { path: ".", pattern: "**" }))).toContain(
      "README.md",
    );
    expect(resultText(await execute(root, "ls", { path: "." }))).toContain("src/");
    expect(await digest(root)).toBe(before);
  });

  test("rejects traversal, outside absolute paths, and escaping symlinks", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-advisor-outside-"));
    directories.push(outside);
    await writeFile(join(outside, "secret"), "secret");
    await symlink(join(outside, "secret"), join(root, "escape"));

    for (const path of ["../outside", join(outside, "secret"), "escape"]) {
      await expect(execute(root, "read", { path })).rejects.toThrow(AdvisorToolSafetyError);
    }
  });

  test("treats grep patterns literally and cannot execute catastrophic JavaScript regex", async () => {
    const root = await fixture();
    await writeFile(join(root, "redos.txt"), `${"a".repeat(100_000)}!\n(a+)+$\n`);
    const started = performance.now();
    const result = await execute(root, "grep", { path: ".", pattern: "(a+)+$" });
    expect(resultText(result)).toContain("redos.txt:2");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("matches **/*.ts at both project root and nested paths", async () => {
    const root = await fixture();
    await writeFile(join(root, "root.ts"), "root\n");
    const text = resultText(await execute(root, "find", { path: ".", pattern: "**/*.ts" }));
    expect(text).toContain("root.ts");
    expect(text).toContain("src/a.ts");
    expect(text).not.toContain("README.md");
  });

  test("rejects oversized path and grep pattern strings at execution boundaries", async () => {
    const root = await fixture();
    const longPath = "a".repeat(ADVISOR_TOOL_LIMITS.maxPathChars + 1);
    await expect(execute(root, "read", { path: longPath })).rejects.toThrow(AdvisorToolSafetyError);
    await expect(execute(root, "find", { path: longPath, pattern: "**" })).rejects.toThrow(
      AdvisorToolSafetyError,
    );
    await expect(execute(root, "grep", { path: longPath, pattern: "answer" })).rejects.toThrow(
      AdvisorToolSafetyError,
    );
    await expect(execute(root, "grep", { path: ".", pattern: longPath })).rejects.toThrow(
      AdvisorToolSafetyError,
    );
  });

  test("declares schema limits for path and pattern strings", async () => {
    const tools = await createAdvisorTools(await fixture());
    expect(JSON.stringify(tools.find((tool) => tool.name === "read")?.parameters)).toContain(
      `"maxLength":${ADVISOR_TOOL_LIMITS.maxPathChars}`,
    );
    expect(JSON.stringify(tools.find((tool) => tool.name === "grep")?.parameters)).toContain(
      `"maxLength":${ADVISOR_TOOL_LIMITS.maxPatternChars}`,
    );
  });

  test("rejects oversized find patterns without regular-expression evaluation", async () => {
    const root = await fixture();
    await expect(
      execute(root, "find", {
        path: ".",
        pattern: "*".repeat(ADVISOR_TOOL_LIMITS.maxPatternChars + 1),
      }),
    ).rejects.toThrow(AdvisorToolSafetyError);
  });

  test("glob matching stays bounded for adversarial wildcard patterns", async () => {
    const root = await fixture();
    const pattern = `${"*a".repeat(ADVISOR_TOOL_LIMITS.maxPatternChars / 2 - 3)}*.ts`;
    const started = performance.now();
    await execute(root, "find", { path: ".", pattern });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("does not follow symlinked directories during recursive grep or find", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "pi-advisor-outside-dir-"));
    directories.push(outside);
    await writeFile(join(outside, "credential.txt"), "outside-only-secret");
    await symlink(outside, join(root, "linked-directory"));
    expect(resultText(await execute(root, "find", { path: ".", pattern: "**" }))).not.toContain(
      "credential.txt",
    );
    expect(
      resultText(await execute(root, "grep", { path: ".", pattern: "outside-only-secret" })),
    ).not.toContain("outside-only-secret");
  });

  test("glob walks apply global visited-directory and entry caps", async () => {
    const root = await fixture();
    for (let index = 0; index < ADVISOR_TOOL_LIMITS.maxVisitedDirectories + 5; index += 1) {
      await mkdir(join(root, `directory-${index}`));
      await writeFile(join(root, `directory-${index}`, "value.txt"), "bounded\n");
    }
    const result = await execute(root, "find", { path: ".", pattern: "**" });
    expect(resultText(result)).toContain("output truncated");
  });

  test("rejects an already-aborted tool execution without opening content", async () => {
    const root = await fixture();
    const read = (await createAdvisorTools(root)).find((tool) => tool.name === "read");
    const controller = new AbortController();
    controller.abort();
    await expect(
      read?.execute("call", { path: "README.md" }, controller.signal, undefined, {} as never),
    ).rejects.toThrow();
  });

  test.runIf(process.platform !== "win32")("rejects FIFO reads without blocking", async () => {
    const root = await fixture();
    const fifo = join(root, "pipe");
    const created = childProcess.spawnSync("mkfifo", [fifo]);
    expect(created.status).toBe(0);
    const started = performance.now();
    await expect(execute(root, "read", { path: "pipe" })).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("bounds bytes and marks oversized evidence as truncated", async () => {
    const root = await fixture();
    await writeFile(join(root, "large.txt"), "x".repeat(ADVISOR_TOOL_LIMITS.maxBytesPerFile + 50));
    const result = await execute(root, "read", { path: "large.txt" });
    expect(resultText(result).length).toBeLessThan(
      ADVISOR_TOOL_LIMITS.maxBytesPerFile + ADVISOR_TOOL_LIMITS.maxLines * 10,
    );
    expect(resultText(result)).toContain("output truncated");
  });

  test("does not invoke guarded Node process-launch APIs during any tool operation", async () => {
    const guards = [
      vi.spyOn(childProcess, "spawn"),
      vi.spyOn(childProcess, "spawnSync"),
      vi.spyOn(childProcess, "exec"),
      vi.spyOn(childProcess, "execFile"),
      vi.spyOn(childProcess, "fork"),
    ];
    const root = await fixture();
    await execute(root, "read", { path: "README.md" });
    await execute(root, "grep", { path: ".", pattern: "answer" });
    await execute(root, "find", { path: ".", pattern: "**" });
    await execute(root, "ls", { path: "." });
    for (const guard of guards) expect(guard).not.toHaveBeenCalled();
  });

  test("contains no process or mutation implementation path", async () => {
    const source = await readFile(new URL("../src/runtime/tools.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /node:child_process|\bspawn\s*\(|\bexec(File)?\s*\(|pi\.exec|writeFile|rename|unlink/,
    );
    expect(source).toContain("O_NOFOLLOW");
    expect(source).toContain("isSymbolicLink");
  });
});
