import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { NESTED_PACKAGE_DIRECTORIES } from "./workspace-manifest-paths.mjs";

const rootDir = join(import.meta.dirname, "..");
const packagesDir = join(rootDir, "packages");
/** The only subdirectories allowed to carry their own package manifest. */
const declaredNestedPackages = new Set(
  NESTED_PACKAGE_DIRECTORIES.map((nested) => join(packagesDir, nested)),
);
const violations = [];
const ignoredDirectories = new Set([".git", ".pi", "coverage", "dist", "node_modules"]);
const extensionRootAllowlist = new Set([
  "application.ts",
  "extension.ts",
  "layer.ts",
  "protocol.ts",
]);

const hasOwnManifest = async (directory) => {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name === "package.json");
  } catch {
    return false;
  }
};

/**
 * Walk one package's own files. A subdirectory with its own `package.json` must be a declared
 * nested workspace package (for example `pi-code-mode/runtime`); it is then validated as its
 * own package entry instead of leaking into its parent's layout rules. An undeclared nested
 * manifest is a violation, so nesting can never silently exempt files from these rules.
 */
const walkFiles = async (directory, nestedPackages) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (await hasOwnManifest(child)) {
        if (declaredNestedPackages.has(child)) {
          nestedPackages.push(child);
        } else {
          violations.push(
            `${relative(rootDir, child).split(sep).join("/")}/package.json: undeclared nested ` +
              "package manifest (declare it in scripts/workspace-manifest-paths.mjs and " +
              "pnpm-workspace.yaml, or remove it)",
          );
        }
        continue;
      }
      files.push(...(await walkFiles(child, nestedPackages)));
    } else if (entry.isFile()) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
};

const packageDirectories = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesDir, entry.name))
  .sort((left, right) => left.localeCompare(right));

for (let index = 0; index < packageDirectories.length; index += 1) {
  const packageDir = packageDirectories[index];
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const files = await walkFiles(packageDir, packageDirectories);
  const isExtensionPackage = manifest.pi !== undefined;

  for (const file of files) {
    const packageRelativePath = relative(packageDir, file).split(sep).join("/");
    const repositoryRelativePath = relative(rootDir, file).split(sep).join("/");
    const fileName = basename(file);

    if (fileName.endsWith(".spec.ts")) {
      violations.push(`${repositoryRelativePath}: use the *.test.ts suffix instead of *.spec.ts`);
    }
    if (fileName.endsWith(".test.ts") && !packageRelativePath.startsWith("tests/")) {
      violations.push(`${repositoryRelativePath}: package tests must live under tests/`);
    }
    if (!isExtensionPackage || !packageRelativePath.startsWith("src/")) continue;

    if (
      dirname(packageRelativePath) === "src" &&
      fileName.endsWith(".ts") &&
      !extensionRootAllowlist.has(fileName)
    ) {
      violations.push(
        `${repositoryRelativePath}: extension src root allows only ${[...extensionRootAllowlist].join(", ")}`,
      );
    }
    if (fileName.startsWith("host-") && !packageRelativePath.startsWith("src/boundary/")) {
      violations.push(`${repositoryRelativePath}: host-* adapters must live under src/boundary/`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Package layout check failed:\n${violations.map((value) => `- ${value}`).join("\n")}`,
  );
  process.exitCode = 1;
} else {
  console.log("Package layout follows the repository architecture rules.");
}
