import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Nested workspace packages (currently only the private Code Mode runtime, which lives inside
 * the public pi-code-mode package so its source ships in that package's tarball). Keep in sync
 * with `pnpm-workspace.yaml`; the layout check refuses any nested manifest not listed here.
 */
export const NESTED_PACKAGE_DIRECTORIES = ["pi-code-mode/runtime"];

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
