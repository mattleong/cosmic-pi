import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { decodePackageManifest } from "./package-manifest.ts";
import {
  packageScriptViolations,
  packageTsconfigViolations,
  requiredPackageScripts,
} from "./package-tooling.ts";
import { workspacePackageDirectories } from "./workspace-manifest-paths.ts";

const rootDirectory = resolve(import.meta.dirname, "..");
const packageDirectory = join(rootDirectory, "packages", "fixture");
const scripts = Object.fromEntries(requiredPackageScripts.map((name) => [name, "echo checked"]));
const validTsconfig = { extends: "../../tsconfig.effect.json" };

await test("every required package script must be present and nonblank", () => {
  const absent = decodePackageManifest('{"name":"fixture","version":"1.0.0"}');
  assert.equal(packageScriptViolations(absent).length, requiredPackageScripts.length);
  for (const name of requiredPackageScripts) {
    const missing = { ...scripts };
    delete missing[name];
    for (const commands of [missing, { ...scripts, [name]: " \n\t " }]) {
      const manifest = decodePackageManifest(
        JSON.stringify({ name: "fixture", version: "1.0.0", scripts: commands }),
      );
      const violations = packageScriptViolations(manifest);
      assert.equal(violations.length, 1);
      assert.ok(violations[0]?.includes(`scripts.${name}:`));
    }
  }
});

await test("script requirements also apply to shared and private packages", () => {
  for (const extra of [{}, { private: true }, { pi: { extensions: ["./index.ts"] } }]) {
    const manifest = decodePackageManifest(
      JSON.stringify({ name: "fixture", version: "1.0.0", ...extra }),
    );
    assert.equal(packageScriptViolations(manifest).length, requiredPackageScripts.length);
  }
});

await test("nonblank scripts are accepted without interpreting their commands", () => {
  const manifest = decodePackageManifest(
    JSON.stringify({ name: "fixture", version: "1.0.0", scripts }),
  );
  assert.deepEqual(packageScriptViolations(manifest), []);
});

await test("tsconfig inheritance must resolve to the workspace Effect config", () => {
  for (const config of [{}, { extends: "" }, { extends: "../../tsconfig.base.json" }]) {
    assert.ok(
      packageTsconfigViolations(JSON.stringify(config), packageDirectory, rootDirectory).some(
        (violation) => violation.includes("extends"),
      ),
    );
  }
  for (const inherited of [
    "../../tsconfig.effect.json",
    "./../../tsconfig.effect.json",
    "../../packages/../tsconfig.effect.json",
    join(rootDirectory, "tsconfig.effect.json"),
  ]) {
    assert.deepEqual(
      packageTsconfigViolations(
        JSON.stringify({ extends: inherited }),
        packageDirectory,
        rootDirectory,
      ),
      [],
    );
  }
});

await test("package-local plugin options cannot replace the inherited Effect plugin", () => {
  for (const plugins of [[], [{ name: "@effect/language-service" }], null]) {
    assert.ok(
      packageTsconfigViolations(
        JSON.stringify({ ...validTsconfig, compilerOptions: { plugins } }),
        packageDirectory,
        rootDirectory,
      ).some((violation) => violation.includes("compilerOptions.plugins")),
    );
  }
  assert.deepEqual(
    packageTsconfigViolations(
      JSON.stringify({ ...validTsconfig, compilerOptions: { checkJs: true } }),
      packageDirectory,
      rootDirectory,
    ),
    [],
  );
});

await test("malformed config files and script records are rejected", () => {
  for (const text of ["{", "null", "[]", '{"extends":2}', '{"compilerOptions":[]}']) {
    assert.ok(packageTsconfigViolations(text, packageDirectory, rootDirectory).length > 0);
  }
  assert.throws(() =>
    decodePackageManifest('{"name":"fixture","version":"1.0.0","scripts":{"test":false}}'),
  );
});

await test("all discovered workspace packages satisfy the tooling requirements", async () => {
  const directories = await workspacePackageDirectories(rootDirectory);
  assert.ok(directories.length > 0);
  await Promise.all(
    directories.map(async (directory) => {
      const manifestPath = join(directory, "package.json");
      const tsconfigPath = join(directory, "tsconfig.json");
      assert.deepEqual(
        packageScriptViolations(decodePackageManifest(await readFile(manifestPath, "utf8"))),
        [],
        manifestPath,
      );
      assert.deepEqual(
        packageTsconfigViolations(await readFile(tsconfigPath, "utf8"), directory, rootDirectory),
        [],
        tsconfigPath,
      );
    }),
  );
});
