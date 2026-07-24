import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

const rootDir = join(import.meta.dirname, "..");
const packagesDir = join(rootDir, "packages");
const ignoredDirectories = new Set([".git", ".pi", "coverage", "dist", "node_modules"]);
const extensionRootAllowlist = new Set([
  "application.ts",
  "extension.ts",
  "layer.ts",
  "protocol.ts",
]);

const walkFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...(await walkFiles(join(directory, entry.name))));
    } else if (entry.isFile()) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
};

const packageEntries = (await readdir(packagesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name));
const violations = [];

for (const entry of packageEntries) {
  const packageDir = join(packagesDir, entry.name);
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  const files = await walkFiles(packageDir);
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
