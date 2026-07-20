import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(root, "packages");
const rules = [
  "abortController",
  "asyncFunction",
  "directFileSystem",
  "effectRunner",
  "extendsNativeError",
  "globalConsole",
  "globalDate",
  "globalFetch",
  "newPromise",
  "processEnv",
  "rawJson",
  "rawTimer",
  "typeboxImport",
  "unstableEffectImport",
  "zodImport",
];

const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const expectedEffectVersion = /\n  effect: ([^\n]+)/.exec(workspace)?.[1];
const platformVersion = /\n  "@effect\/platform-node": ([^\n]+)/.exec(workspace)?.[1];
const vitestVersion = /\n  "@effect\/vitest": ([^\n]+)/.exec(workspace)?.[1];

if (
  !expectedEffectVersion ||
  expectedEffectVersion !== platformVersion ||
  expectedEffectVersion !== vitestVersion
) {
  throw new Error(
    "Effect, @effect/platform-node, and @effect/vitest must use one exact catalog version.",
  );
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedEffectVersion)) {
  throw new Error(`Effect catalog version must be exact, found ${expectedEffectVersion}.`);
}

const packageNames = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const packageName of packageNames) {
  const configPath = join(packageRoot, packageName, "tsconfig.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.extends !== "../../tsconfig.effect.json") {
    throw new Error(`${packageName}/tsconfig.json must use the strict Effect configuration.`);
  }

  const manifest = JSON.parse(
    await readFile(join(packageRoot, packageName, "package.json"), "utf8"),
  );
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  if (Object.hasOwn(dependencies, "zod")) {
    throw new Error(`${packageName} must use Effect Schema instead of Zod.`);
  }
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "testing")
        files.push(...(await sourceFiles(path)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function approved(rule, path) {
  if (rule === "typeboxImport") return path === "packages/pi-advisor/src/advisor-tools.ts";
  if (rule === "unstableEffectImport")
    return path.startsWith("packages/pi-cosmic-core/src/platform/");
  if (rule === "effectRunner") {
    return path.includes("/boundary/") || path === "packages/pi-cosmic-core/src/runtime.ts";
  }
  if (rule === "directFileSystem")
    return (
      path.startsWith("packages/pi-cosmic-core/src/platform/") ||
      path.startsWith("packages/pi-advisor/src/boundary/")
    );
  if (rule === "globalDate")
    return (
      path === "packages/pi-code-previews/src/boundary/clock.ts" ||
      path === "packages/pi-advisor/src/boundary/clock.ts" ||
      path === "packages/pi-advisor/src/boundary/node.ts"
    );
  if (rule === "globalConsole") return path === "packages/pi-advisor/src/boundary/node.ts";
  if (rule === "rawJson")
    return (
      path === "packages/pi-code-previews/src/boundary/json.ts" ||
      path === "packages/pi-advisor/src/boundary/json.ts"
    );
  return false;
}

function scan(path, source) {
  const counts = Object.fromEntries(rules.map((rule) => [rule, 0]));
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bump = (rule) => {
    if (!approved(rule, path)) counts[rule] += 1;
  };
  const isProperty = (node, owner, property) =>
    ts.isPropertyAccessExpression(node) &&
    node.expression.getText(file) === owner &&
    node.name.text === property;

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (specifier === "node:fs" || specifier === "node:fs/promises") bump("directFileSystem");
      if (specifier === "typebox" || specifier.startsWith("typebox/")) bump("typeboxImport");
      if (specifier === "zod" || specifier.startsWith("zod/")) bump("zodImport");
      if (specifier.startsWith("effect/unstable/")) bump("unstableEffectImport");
    }

    if (
      ts.isFunctionLike(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      bump("asyncFunction");
    }

    if (ts.isClassDeclaration(node) && node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some((type) => type.expression.getText(file) === "Error")
        ) {
          bump("extendsNativeError");
        }
      }
    }

    if (ts.isNewExpression(node)) {
      const expression = node.expression.getText(file);
      if (expression === "AbortController") bump("abortController");
      if (expression === "Promise") bump("newPromise");
      if (expression === "Date") bump("globalDate");
    }

    if (ts.isPropertyAccessExpression(node)) {
      const expression = node.expression.getText(file);
      if (expression === "process" && node.name.text === "env") bump("processEnv");
      if (expression === "console") bump("globalConsole");
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) {
        if (expression.text === "fetch") bump("globalFetch");
        if (
          ["setTimeout", "setInterval", "clearTimeout", "clearInterval"].includes(expression.text)
        ) {
          bump("rawTimer");
        }
      } else if (ts.isPropertyAccessExpression(expression)) {
        const property = expression.name.text;
        if (isProperty(expression, "Date", "now")) bump("globalDate");
        if (
          isProperty(expression, "JSON", "parse") ||
          isProperty(expression, "JSON", "stringify")
        ) {
          bump("rawJson");
        }
        if (
          [
            "runPromise",
            "runPromiseExit",
            "runFork",
            "runSync",
            "runSyncExit",
            "runCallback",
          ].includes(property)
        ) {
          bump("effectRunner");
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  return counts;
}

const current = {};
for (const packageName of packageNames) {
  const packageCounts = Object.fromEntries(rules.map((rule) => [rule, 0]));
  const packageDirectory = join(packageRoot, packageName);
  const src = join(packageDirectory, "src");
  const productionFiles = [join(packageDirectory, "index.ts"), ...(await sourceFiles(src))];
  for (const absolutePath of productionFiles) {
    const path = relative(root, absolutePath);
    const counts = scan(path, await readFile(absolutePath, "utf8"));
    for (const rule of rules) packageCounts[rule] += counts[rule];
  }
  current[packageName] = packageCounts;
}

for (const packageName of packageNames) {
  for (const rule of rules) {
    if (current[packageName][rule] > 0) {
      throw new Error(
        `${packageName} has ${current[packageName][rule]} unapproved ${rule} violation(s).`,
      );
    }
  }
}

console.log(
  `Effect architecture ratchet verified for ${packageNames.length} packages at ${expectedEffectVersion}.`,
);
