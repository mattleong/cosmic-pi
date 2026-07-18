import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
  private?: boolean;
  pi?: {
    extensions?: string[];
  };
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("pi package manifest", () => {
  test("declares an importable extension entrypoint and remains private", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(packageDirectory, "package.json"), "utf8"),
    ) as PackageManifest;

    expect(manifest.private).toBe(true);
    expect(manifest.pi?.extensions).toEqual(["./index.ts"]);

    for (const extension of manifest.pi?.extensions ?? []) {
      const entrypoint = resolve(packageDirectory, extension);
      const module = (await import(pathToFileURL(entrypoint).href)) as {
        default?: unknown;
      };
      expect(module.default).toBeTypeOf("function");
    }
  });

  test("declares only imported runtime dependencies and no process-capability dependency", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(packageDirectory, "package.json"), "utf8"),
    ) as PackageManifest;
    expect(manifest.dependencies).toEqual({
      "pi-better-openai": "workspace:*",
      typebox: "1.1.38",
    });
    expect(Object.keys(manifest.dependencies ?? {})).not.toEqual(
      expect.arrayContaining(["execa", "shelljs", "zx", "minimatch"]),
    );

    const toolSource = await readFile(resolve(packageDirectory, "src/advisor-tools.ts"), "utf8");
    expect(toolSource).not.toMatch(/node:child_process|\bspawn\s*\(|\bexec(File)?\s*\(|pi\.exec/);
  });
});
