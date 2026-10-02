import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  workspaceManifestPaths,
  workspacePackageDirectories,
} from "./workspace-manifest-paths.mjs";

test("workspace checks ignore manifest-less retired residue but include real packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cosmic-manifests-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const current = join(root, "packages", "current");
  const retired = join(root, "packages", "retired");
  await mkdir(current, { recursive: true });
  await mkdir(join(retired, "node_modules"), { recursive: true });
  await mkdir(join(retired, "src", ".claude"), { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(current, "package.json"), "{}");
  assert.deepEqual(await workspacePackageDirectories(root), [current]);
  assert.deepEqual(await workspaceManifestPaths(root), [
    join(root, "package.json"),
    join(current, "package.json"),
  ]);

  // Adding a manifest makes the previously ignored directory part of the workspace again.
  await writeFile(join(retired, "package.json"), "{}");
  assert.deepEqual(await workspacePackageDirectories(root), [current, retired]);
});
