import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(rootDir, "packages");
const expectedVersion = process.argv[2];

const packageDirectories = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name))
  .sort();

const manifestPaths = [rootDir, ...packageDirectories].map((directory) =>
  join(directory, "package.json"),
);
const manifests = await Promise.all(
  manifestPaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
);
const versions = new Map(manifests.map(({ name, version }) => [name, version]));
const uniqueVersions = new Set(versions.values());

if (uniqueVersions.size !== 1) {
  const details = [...versions].map(([name, version]) => `${name}: ${version}`).join("\n");
  throw new Error(`Workspace package versions are not synchronized:\n${details}`);
}

const [version] = uniqueVersions;
if (expectedVersion && version !== expectedVersion) {
  throw new Error(`Expected workspace version ${expectedVersion}, found ${version}`);
}

console.log(`All workspace packages use version ${version}.`);
