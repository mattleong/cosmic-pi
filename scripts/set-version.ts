import { readFile, writeFile } from "node:fs/promises";

import { Effect } from "effect";

import { decodeManifestDocument, decodePackageManifest } from "./package-manifest.ts";
import { workspaceManifestPaths } from "./workspace-manifest-paths.ts";

const version = process.argv[2];
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!version || !semverPattern.test(version)) {
  throw new Error("Usage: pnpm version:set <semver>");
}

const updateManifest = async (manifestPath: string): Promise<void> => {
  const text = await readFile(manifestPath, "utf8");
  const { name } = decodePackageManifest(text);
  const manifest = { ...decodeManifestDocument(text), version };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated ${name} to ${version}`);
};

const manifestPaths = await workspaceManifestPaths();

await Effect.runPromise(
  Effect.forEach(
    manifestPaths,
    (manifestPath) => Effect.promise(() => updateManifest(manifestPath)),
    {
      discard: true,
    },
  ),
);
