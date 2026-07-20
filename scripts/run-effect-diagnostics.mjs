import { spawnSync } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packages = join(root, "packages");
const configs = [];
for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const config = join(packages, entry.name, "tsconfig.json");
  try {
    await access(config, constants.R_OK);
    configs.push(`packages/${entry.name}/tsconfig.json`);
  } catch {
    // Directories without a TypeScript project are not diagnostic projects.
  }
}
configs.sort();
if (configs.length === 0) throw new Error("No workspace package TypeScript projects were found.");

for (const config of configs) {
  const result = spawnSync(
    "pnpm",
    ["exec", "effect-language-service", "diagnostics", "--project", config],
    { cwd: root, encoding: "utf8", env: process.env },
  );
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.status !== 0)
    throw new Error(`Effect diagnostics failed for ${config} with status ${result.status}.`);
}
console.log(`Effect diagnostics passed for ${configs.length} dynamically enumerated projects.`);
