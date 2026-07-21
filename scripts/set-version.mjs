import { readFile, writeFile } from "node:fs/promises";

import { workspaceManifestPaths } from "./workspace-manifest-paths.mjs";

const version = process.argv[2];
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!version || !semverPattern.test(version)) {
  throw new Error("Usage: pnpm version:set <semver>");
}

const manifestPaths = await workspaceManifestPaths();

for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated ${manifest.name} to ${version}`);
}
