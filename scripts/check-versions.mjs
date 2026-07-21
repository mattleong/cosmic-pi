import { readFile } from "node:fs/promises";

import { workspaceManifestPaths } from "./workspace-manifest-paths.mjs";

const expectedVersion = process.argv[2];
const manifestPaths = await workspaceManifestPaths();
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
