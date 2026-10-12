import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { decodePackageManifest } from "./package-manifest.ts";
import { packageScriptViolations, packageTsconfigViolations } from "./package-tooling.ts";
import { workspacePackageDirectories } from "./workspace-manifest-paths.ts";

const rootDir = join(import.meta.dirname, "..");
const violations: string[] = [];
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

const hasOwnManifest = async (directory: string): Promise<boolean> => {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name === "package.json");
  } catch {
    return false;
  }
};

interface PackageWalk {
  readonly files: readonly string[];
  readonly violations: readonly string[];
}

const emptyWalk: PackageWalk = { files: [], violations: [] };

async function walkEntry(directory: string, entry: Dirent): Promise<PackageWalk> {
  if (entry.isFile()) return { files: [join(directory, entry.name)], violations: [] };
  if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) return emptyWalk;
  const child = join(directory, entry.name);
  if (await hasOwnManifest(child)) {
    return {
      files: [],
      violations: [
        `${relative(rootDir, child).split(sep).join("/")}/package.json: nested package ` +
          "manifest (remove it, or make it a top-level packages/* workspace package)",
      ],
    };
  }
  return walkFiles(child);
}

async function walkFiles(directory: string): Promise<PackageWalk> {
  const entries = await readdir(directory, { withFileTypes: true });
  const walks = await Promise.all(entries.map((entry) => walkEntry(directory, entry)));
  return {
    files: walks.flatMap((walk) => walk.files),
    violations: walks.flatMap((walk) => walk.violations),
  };
}

async function readPackageManifest(packageDir: string) {
  const path = join(packageDir, "package.json");
  try {
    const manifest = decodePackageManifest(await readFile(path, "utf8"));
    return {
      manifest,
      violations: packageScriptViolations(manifest).map(
        (violation) => `${relative(rootDir, path)}: ${violation}`,
      ),
    };
  } catch {
    return {
      manifest: undefined,
      violations: [`${relative(rootDir, path)}: missing, unreadable or malformed package manifest`],
    };
  }
}

async function checkPackageTsconfig(packageDir: string): Promise<string[]> {
  const path = join(packageDir, "tsconfig.json");
  try {
    const text = await readFile(path, "utf8");
    return packageTsconfigViolations(text, packageDir, rootDir).map(
      (violation) => `${relative(rootDir, path)}: ${violation}`,
    );
  } catch {
    return [`${relative(rootDir, path)}: missing or unreadable required tsconfig.json`];
  }
}

const packageDirectories = await workspacePackageDirectories(rootDir);
const packages = await Promise.all(
  packageDirectories.map(async (packageDir) => ({
    packageDir,
    manifestCheck: await readPackageManifest(packageDir),
    tsconfigViolations: await checkPackageTsconfig(packageDir),
    walk: await walkFiles(packageDir),
  })),
);

for (const { packageDir, manifestCheck, tsconfigViolations, walk } of packages) {
  violations.push(...manifestCheck.violations, ...tsconfigViolations, ...walk.violations);
  const { manifest } = manifestCheck;
  if (manifest === undefined) continue;
  const files = walk.files;
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
