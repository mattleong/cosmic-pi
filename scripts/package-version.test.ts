import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { decodePackageManifest } from "./package-manifest.ts";

await test("version commands reject malformed versions before mutation and accept repaired releases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cosmic-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "packages", "extension"), { recursive: true });
  await symlink(
    resolve(import.meta.dirname, "../node_modules"),
    join(root, "node_modules"),
    "junction",
  );
  await Promise.all(
    [
      "check-versions.ts",
      "set-version.ts",
      "package-manifest.ts",
      "workspace-manifest-paths.ts",
    ].map((file) => copyFile(join(import.meta.dirname, file), join(root, "scripts", file))),
  );
  const paths = [join(root, "package.json"), join(root, "packages", "extension", "package.json")];
  await Promise.all(
    paths.map((path, index) =>
      writeFile(
        path,
        JSON.stringify({ name: `fixture-${index}`, version: "0.2.0", type: "module" }),
      ),
    ),
  );
  const originals = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const rejected = spawnSync(process.execPath, [
    join(root, "scripts", "set-version.ts"),
    "1.2.3-01",
  ]);
  assert.notEqual(rejected.status, 0);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, "utf8"))), originals);

  await Promise.all(
    paths.map((path, index) =>
      writeFile(
        path,
        JSON.stringify({ name: `fixture-${index}`, version: "1.2.3-alpha..1", type: "module" }),
      ),
    ),
  );
  const invalid = spawnSync(process.execPath, [join(root, "scripts", "check-versions.ts")]);
  assert.notEqual(invalid.status, 0);

  const version = "1.2.3-alpha.1+build.001";
  const updated = spawnSync(process.execPath, [join(root, "scripts", "set-version.ts"), version]);
  assert.equal(updated.status, 0, updated.stderr.toString());
  const updatedManifests = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  assert.deepEqual(
    updatedManifests.map((text) => decodePackageManifest(text).version),
    [version, version],
  );
  const checked = spawnSync(process.execPath, [
    join(root, "scripts", "check-versions.ts"),
    version,
  ]);
  assert.equal(checked.status, 0, checked.stderr.toString());
});
