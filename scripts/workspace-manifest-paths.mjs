import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Nested workspace packages inside another package's directory (currently none). Keep in sync
 * with `pnpm-workspace.yaml`; the layout check refuses any nested manifest not listed here.
 */
export const NESTED_PACKAGE_DIRECTORIES = [];

export async function workspaceManifestPaths() {
  const rootDir = resolve(import.meta.dirname, "..");
  const packageDirectories = (await readdir(join(rootDir, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootDir, "packages", entry.name));
  const nestedDirectories = [];
  for (const nested of NESTED_PACKAGE_DIRECTORIES) {
    const directory = join(rootDir, "packages", nested);
    try {
      await access(join(directory, "package.json"));
      nestedDirectories.push(directory);
    } catch {
      throw new Error(`Missing nested workspace package manifest: packages/${nested}`);
    }
  }
  const directories = [...packageDirectories, ...nestedDirectories].sort();

  return [rootDir, ...directories].map((directory) => join(directory, "package.json"));
}
