import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function workspaceManifestPaths() {
  const rootDir = resolve(import.meta.dirname, "..");
  const packageDirectories = (await readdir(join(rootDir, "packages"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootDir, "packages", entry.name))
    .sort();

  return [rootDir, ...packageDirectories].map((directory) => join(directory, "package.json"));
}
