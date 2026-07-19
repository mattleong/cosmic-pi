import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageConfigs = (await readdir(join(root, "packages"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}/tsconfig.json`)
  .sort();

function run(args) {
  return spawnSync("pnpm", args, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const patchCheck = run(["exec", "effect-language-service", "check"]);
if (patchCheck.status !== 0) {
  throw new Error(`Effect language-service patch check failed:\n${output(patchCheck)}`);
}

for (const config of packageConfigs) {
  const shown = run(["exec", "tsc", "--showConfig", "-p", config]);
  if (shown.status !== 0) {
    throw new Error(`Failed to resolve ${config}:\n${output(shown)}`);
  }
  const resolved = JSON.parse(shown.stdout);
  const plugins = resolved.compilerOptions?.plugins ?? [];
  if (!plugins.some((plugin) => plugin.name === "@effect/language-service")) {
    throw new Error(`${config} does not inherit the Effect language-service plugin.`);
  }
}

const fixtureConfig = "scripts/fixtures/effect-lsp/tsconfig.json";
const compilation = run(["exec", "tsc", "--pretty", "false", "-p", fixtureConfig]);
const compilationOutput = output(compilation);
if (compilation.status !== 2 || !compilationOutput.includes("effect(floatingEffect)")) {
  throw new Error(
    `Patched tsc did not reject the floating-Effect fixture as expected:\n${compilationOutput}`,
  );
}

const diagnostics = run([
  "exec",
  "effect-language-service",
  "diagnostics",
  "--project",
  fixtureConfig,
]);
const diagnosticsOutput = output(diagnostics);
if (diagnostics.status !== 1 || !diagnosticsOutput.includes("effect(floatingEffect)")) {
  throw new Error(
    `Effect diagnostics CLI missed the floating-Effect fixture:\n${diagnosticsOutput}`,
  );
}

console.log(
  `Effect LSP verified: patched TypeScript and ${packageConfigs.length} package configs report diagnostics.`,
);
