import { readFile, writeFile } from "node:fs/promises";

import * as Effect from "effect/Effect";

import {
  decodeManifestDocument,
  decodePackageManifest,
  isPackageVersion,
} from "./package-manifest.ts";
import { workspaceManifestPaths } from "./workspace-manifest-paths.ts";

const version = process.argv[2];
if (!version || !isPackageVersion(version)) {
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
