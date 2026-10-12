import { resolve } from "node:path";
import * as Schema from "effect/Schema";

import type { PackageManifest } from "./package-manifest.ts";

export const requiredPackageScripts = [
  "check",
  "validate",
  "typecheck",
  "effect:diagnostics",
  "lint",
  "lint:fix",
  "format:check",
  "test",
] as const;

const PackageTsconfig = Schema.Struct({
  extends: Schema.optional(Schema.String),
  compilerOptions: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});

const packageTsconfigFromJson = Schema.decodeUnknownSync(Schema.fromJsonString(PackageTsconfig));

export function packageScriptViolations(manifest: PackageManifest): string[] {
  return requiredPackageScripts.flatMap((name) => {
    const command = manifest.scripts?.[name];
    return command === undefined || command.trim().length === 0
      ? [`scripts.${name}: required nonblank script`]
      : [];
  });
}

export function packageTsconfigViolations(
  text: string,
  packageDirectory: string,
  rootDirectory: string,
): string[] {
  let config: typeof PackageTsconfig.Type;
  try {
    config = packageTsconfigFromJson(text);
  } catch {
    return ["invalid JSON or tsconfig structure"];
  }
  const violations: string[] = [];
  if (
    config.extends === undefined ||
    config.extends.trim().length === 0 ||
    resolve(packageDirectory, config.extends) !== resolve(rootDirectory, "tsconfig.effect.json")
  ) {
    violations.push("extends must resolve to the root tsconfig.effect.json");
  }
  if (config.compilerOptions !== undefined && Object.hasOwn(config.compilerOptions, "plugins")) {
    violations.push("compilerOptions.plugins must not replace the inherited Effect plugin");
  }
  return violations;
}
