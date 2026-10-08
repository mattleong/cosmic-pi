import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function workspacePackageDirectories(rootDir = resolve(import.meta.dirname, "..")) {
  const directories = [];
  for (const entry of await readdir(join(rootDir, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(rootDir, "packages", entry.name);
    try {
      await access(join(directory, "package.json"));
      directories.push(directory);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Retired packages can leave ignored node_modules and native-agent state behind.
    }
  }
  return directories.sort();
}

export async function workspaceManifestPaths(rootDir = resolve(import.meta.dirname, "..")) {
  const packageDirectories = await workspacePackageDirectories(rootDir);
  return [rootDir, ...packageDirectories].map((directory) => join(directory, "package.json"));
}
