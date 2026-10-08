import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { workspacePackageDirectories } from "./workspace-manifest-paths.mjs";

const rootDir = join(import.meta.dirname, "..");
const violations = [];
const hostProvidedPackages = new Set([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
]);
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
 * Walk one package's own files. A subdirectory with its own `package.json` is a violation and
 * is not descended into, so nesting can never silently exempt files from these rules.
 */
const walkFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (await hasOwnManifest(child)) {
        violations.push(
          `${relative(rootDir, child).split(sep).join("/")}/package.json: nested package ` +
            "manifest (remove it, or make it a top-level packages/* workspace package)",
        );
        continue;
      }
      files.push(...(await walkFiles(child)));
    } else if (entry.isFile()) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
};

const packageDirectories = await workspacePackageDirectories(rootDir);

for (const packageDir of packageDirectories) {
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const files = await walkFiles(packageDir);
  const isExtensionPackage = manifest.pi !== undefined;

  for (const name of hostProvidedPackages) {
    const manifestPath = relative(rootDir, join(packageDir, "package.json"));
    if (manifest.dependencies?.[name] || manifest.optionalDependencies?.[name]) {
      violations.push(`${manifestPath}: host-provided ${name} must not be a runtime dependency`);
    }
    if (
      manifest.peerDependencies?.[name] !== undefined &&
      manifest.peerDependencies[name] !== "*"
    ) {
      violations.push(`${manifestPath}: host-provided ${name} requires a "*" peer dependency`);
    }
  }

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
