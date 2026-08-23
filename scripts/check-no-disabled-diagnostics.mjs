import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const self = "scripts/check-no-disabled-diagnostics.mjs";
const rootConfigurations = new Set([
  ".oxlintrc.json",
  "tsconfig.base.json",
  "tsconfig.effect.json",
]);
const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(
    (path) =>
      path &&
      path !== self &&
      (path.startsWith("packages/") ||
        path.startsWith("scripts/") ||
        path.startsWith("tools/") ||
        rootConfigurations.has(path)),
  );

const disabledSeverity = "off";
const allowedSeverity = "allow";
const suppressionMarker = "disable";
const sourcePattern = new RegExp(
  `@effect-diagnostics[^\\n]*:${disabledSeverity}|(?:oxlint|eslint)-${suppressionMarker}|@ts-(?:ignore|expect-error|nocheck)`,
  "u",
);
const disabledRulePattern = new RegExp(
  `"[A-Za-z0-9/_-]+"\\s*:\\s*(?:"(?:${disabledSeverity}|${allowedSeverity})"|0(?:\\s*[,}]|$)|\\[\\s*(?:"(?:${disabledSeverity}|${allowedSeverity})"|0))`,
  "u",
);
const disabledEffectSwitchPattern = /"(?:diagnostics|includeSuggestionsInTsc)"\s*:\s*false/u;
const ignoredEffectExitPattern =
  /"ignoreEffect(?:Warnings|Errors|Suggestions)InTscExitCode"\s*:\s*true/u;
const findings = [];

for (const path of tracked) {
  if (!/\.(?:[cm]?[jt]sx?|jsonc?)$/u.test(path) || !existsSync(path)) continue;
  const source = readFileSync(path, "utf8");
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (sourcePattern.test(line)) findings.push(`${path}:${index + 1}: ${line.trim()}`);
  }

  const isDiagnosticConfig = /(?:^|\/)(?:\.oxlintrc\.json|tsconfig[^/]*\.json)$/u.test(path);
  if (!isDiagnosticConfig) continue;
  for (const pattern of [
    disabledRulePattern,
    disabledEffectSwitchPattern,
    ignoredEffectExitPattern,
  ]) {
    const matchIndex = source.search(pattern);
    if (matchIndex < 0) continue;
    const lineNumber = source.slice(0, matchIndex).split("\n").length;
    findings.push(`${path}:${lineNumber}: disabled diagnostic configuration`);
  }
}

if (findings.length > 0) {
  process.stderr.write(`Disabled diagnostics are not allowed:\n${findings.join("\n")}\n`);
  process.exitCode = 1;
}
