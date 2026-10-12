import { access, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

function missingFile(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

export async function workspacePackageDirectories(
  rootDir = resolve(import.meta.dirname, ".."),
): Promise<string[]> {
  const entries = await readdir(join(rootDir, "packages"), { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(rootDir, "packages", entry.name);
        try {
          await access(join(directory, "package.json"));
          return directory;
        } catch (cause) {
          if (!(cause instanceof Error) || !missingFile(cause)) throw cause;
          return undefined;
        }
      }),
  );
  return candidates
    .filter((directory) => directory !== undefined)
    .toSorted((left, right) => (left === right ? 0 : left < right ? -1 : 1));
}

export async function workspaceManifestPaths(
  rootDir = resolve(import.meta.dirname, ".."),
): Promise<string[]> {
  const packageDirectories = await workspacePackageDirectories(rootDir);
  return [rootDir, ...packageDirectories].map((directory) => join(directory, "package.json"));
}
