import { readFile, writeFile } from "node:fs/promises";

import { decodeManifestDocument, decodePackageManifest } from "./package-manifest.ts";
import { workspaceManifestPaths } from "./workspace-manifest-paths.ts";

const version = process.argv[2];
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!version || !semverPattern.test(version)) {
  throw new Error("Usage: pnpm version:set <semver>");
}

const manifestPaths = await workspaceManifestPaths();

for (const manifestPath of manifestPaths) {
  const text = await readFile(manifestPath, "utf8");
  const { name } = decodePackageManifest(text);
  const manifest = { ...decodeManifestDocument(text), version };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated ${name} to ${version}`);
}
