import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ADVISOR_TOOL_LIMITS,
  ADVISOR_TOOL_NAMES,
  AdvisorToolSafetyError,
  createAdvisorTools,
  isPackageAdvisorTool,
} from "../src/advisor-tools.ts";

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
  test("exposes exactly read, grep, find and ls with package identity", async () => {
    const tools = await createAdvisorTools(await fixture());
    expect(tools.map((tool) => tool.name)).toEqual(ADVISOR_TOOL_NAMES);
    expect(tools.every((tool) => isPackageAdvisorTool(tool))).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["bash", "write", "edit", "patch", "exec", "custom", "all"]),
    );
  });

  test("rejects direct unsafe tool names without changing the workspace", async () => {
    const root = await fixture();
    const before = await digest(root);
    const tools = await createAdvisorTools(root);
    for (const name of [
      "bash",
      "write",
      "edit",
      "patch",
      "exec",
      "process",
      "custom",
      "all",
      "provider-tool",
    ]) {
      expect(tools.find((tool) => tool.name === name)).toBeUndefined();
    }
    expect(await digest(root)).toBe(before);
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
    const source = await readFile(new URL("../src/advisor-tools.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(
      /node:child_process|\bspawn\s*\(|\bexec(File)?\s*\(|pi\.exec|writeFile|rename|unlink/,
    );
    expect(source).toContain("O_NOFOLLOW");
    expect(source).toContain("isSymbolicLink");
  });
});
