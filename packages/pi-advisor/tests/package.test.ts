// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";

interface PackageManifest {
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
});
