import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = join(root, "packages");
export const architectureRules = [
  "abortController",
  "asyncFunction",
  "bodyJsonUnsafe",
  "directFileSystem",
  "effectRunner",
  "expectedErrorThrow",
  "extendsNativeError",
  "globalConsole",
  "globalDate",
  "globalFetch",
  "leakedHttpLayer",
  "newPromise",
  "processEnv",
  "rawJson",
  "rawTimer",
  "typeboxImport",
  "unsafeEffectOperation",
  "unstableEffectImport",
  "zodImport",
];

const exactFileAllowlists = {
  typeboxImport: new Set(["packages/pi-advisor/src/advisor-tools.ts"]),
  directFileSystem: new Set([
    "packages/pi-cosmic-core/src/platform/safe-file.ts",
    "packages/pi-advisor/src/boundary/read-only-fs.ts",
    "packages/pi-advisor/src/boundary/node.ts",
  ]),
  globalDate: new Set([
    "packages/pi-code-previews/src/boundary/clock.ts",
    "packages/pi-advisor/src/boundary/clock.ts",
    "packages/pi-advisor/src/boundary/node.ts",
  ]),
  globalConsole: new Set(["packages/pi-advisor/src/boundary/node.ts"]),
  rawJson: new Set([
    "packages/pi-code-previews/src/boundary/json.ts",
    "packages/pi-advisor/src/boundary/json.ts",
  ]),
  leakedHttpLayer: new Set([
    "packages/pi-cosmic-core/src/platform/json-http.ts",
    "packages/pi-cosmic-core/src/platform/streaming-http.ts",
  ]),
};

const exactImportAllowlists = new Map([
  [
    "packages/pi-cosmic-core/src/platform/json-http.ts",
    new Set(["effect/unstable/http/HttpClient", "effect/unstable/http/HttpClientRequest"]),
  ],
  [
    "packages/pi-cosmic-core/src/platform/streaming-http.ts",
    new Set(["effect/unstable/http/HttpClient", "effect/unstable/http/HttpClientRequest"]),
  ],
]);

const exactRunnerAllowlists = new Map([
  [
    "packages/pi-cosmic-core/src/runtime.ts",
    new Set(["runtime.runPromise", "runtime.runFork", "runtime.runSync"]),
  ],
  ["packages/pi-code-previews/src/boundary/settings-one-shot.ts", new Set(["Effect.runPromise"])],
  [
    "packages/pi-advisor/src/boundary/executor.ts",
    new Set(["Effect.runPromise", "Effect.runFork", "Effect.runSync"]),
  ],
]);

const hasExportModifier = (node) =>
  ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;

function isEffectGenCall(node, file) {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.getText(file) === "Effect.gen"
  );
}

function callbackHasDirectThrow(callback) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(node) && node !== callback) return;
    ts.forEachChild(node, visit);
  };
  visit(callback.body);
  return found;
}

export function scanArchitectureSource(path, source, options = {}) {
  const applyProductionAllowlists = options.applyProductionAllowlists ?? true;
  const ignoredRules = new Set(options.ignoredRules ?? []);
  const violations = [];
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const unstableAliases = new Set();
  const effectNamespaces = new Set();
  const managedRuntimeNamespaces = new Set();
  const namedEffectRunners = new Map();
  const managedRuntimeBindings = new Set();
  const managedRuntimeFactories = new Set();
  const rawHttpBindings = new Set();
  const bump = (rule, node, detail = "") => {
    if (ignoredRules.has(rule)) return;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    violations.push({ rule, path, line, detail });
  };
  const fileApproved = (rule) =>
    applyProductionAllowlists && exactFileAllowlists[rule]?.has(path) === true;
  const isProperty = (node, owner, property) =>
    ts.isPropertyAccessExpression(node) &&
    node.expression.getText(file) === owner &&
    node.name.text === property;

  const runnerNames = new Set([
    "runPromise",
    "runPromiseExit",
    "runFork",
    "runSync",
    "runSyncExit",
    "runCallback",
  ]);
  const containsBinding = (node, bindings) => {
    let found = false;
    const inspect = (child) => {
      if (found) return;
      if (ts.isIdentifier(child) && bindings.has(child.text)) {
        found = true;
        return;
      }
      ts.forEachChild(child, inspect);
    };
    inspect(node);
    return found;
  };
  const containsLayerProvide = (node) => {
    let found = false;
    const inspect = (child) => {
      if (found) return;
      if (
        ts.isCallExpression(child) &&
        ts.isPropertyAccessExpression(child.expression) &&
        child.expression.name.text === "provide" &&
        child.expression.expression.getText(file) === "Layer"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(child, inspect);
    };
    inspect(node);
    return found;
  };
  const declaredIdentifiers = (name) => (ts.isIdentifier(name) ? [name.text] : []);

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (specifier === "effect/Effect") {
      if (bindings && ts.isNamespaceImport(bindings)) effectNamespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (runnerNames.has(imported)) namedEffectRunners.set(element.name.text, imported);
        }
      }
    }
    if (specifier === "effect/ManagedRuntime" && bindings && ts.isNamespaceImport(bindings))
      managedRuntimeNamespaces.add(bindings.name.text);
    if (specifier === "effect/unstable/http/HttpClient" && bindings) {
      if (ts.isNamespaceImport(bindings)) {
        unstableAliases.add(bindings.name.text);
        rawHttpBindings.add(bindings.name.text);
      } else if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) rawHttpBindings.add(element.name.text);
      }
    }
  }

  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.type &&
      containsBinding(statement.type, managedRuntimeNamespaces)
    )
      managedRuntimeFactories.add(statement.name.text);
  }

  // Resolve simple local aliases before applying rules. This intentionally follows bindings,
  // rather than matching property names, so unrelated runPromise methods remain valid.
  let bindingsChanged = true;
  while (bindingsChanged) {
    bindingsChanged = false;
    for (const statement of file.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const names = declaredIdentifiers(declaration.name);
        if (names.length === 0) continue;
        const initializer = declaration.initializer;
        const rawSource =
          (initializer && containsBinding(initializer, rawHttpBindings)) ||
          (declaration.type && containsBinding(declaration.type, rawHttpBindings));
        if (rawSource && (!initializer || !containsLayerProvide(initializer))) {
          for (const name of names) {
            if (!rawHttpBindings.has(name)) {
              rawHttpBindings.add(name);
              bindingsChanged = true;
            }
          }
        }
        const managedSource =
          initializer &&
          ((ts.isCallExpression(initializer) &&
            ((ts.isPropertyAccessExpression(initializer.expression) &&
              managedRuntimeNamespaces.has(initializer.expression.expression.getText(file)) &&
              initializer.expression.name.text === "make") ||
              (ts.isIdentifier(initializer.expression) &&
                managedRuntimeFactories.has(initializer.expression.text)))) ||
            (ts.isIdentifier(initializer) && managedRuntimeBindings.has(initializer.text)));
        if (managedSource) {
          for (const name of names) {
            if (!managedRuntimeBindings.has(name)) {
              managedRuntimeBindings.add(name);
              bindingsChanged = true;
            }
          }
        }
        if (
          initializer &&
          ts.isPropertyAccessExpression(initializer) &&
          effectNamespaces.has(initializer.expression.getText(file)) &&
          runnerNames.has(initializer.name.text)
        )
          for (const name of names) namedEffectRunners.set(name, initializer.name.text);
      }
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (
        (specifier === "node:fs" || specifier === "node:fs/promises") &&
        !fileApproved("directFileSystem")
      )
        bump("directFileSystem", node, specifier);
      if (
        (specifier === "typebox" || specifier.startsWith("typebox/")) &&
        !fileApproved("typeboxImport")
      )
        bump("typeboxImport", node, specifier);
      if (specifier === "zod" || specifier.startsWith("zod/")) bump("zodImport", node, specifier);
      if (specifier.startsWith("effect/unstable/")) {
        const approved =
          applyProductionAllowlists && exactImportAllowlists.get(path)?.has(specifier) === true;
        if (!approved) bump("unstableEffectImport", node, specifier);
      }
    }

    if (
      ts.isFunctionLike(node) &&
      ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      bump("asyncFunction", node);

    if (ts.isClassDeclaration(node) && node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        if (
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          clause.types.some((type) => type.expression.getText(file) === "Error")
        )
          bump("extendsNativeError", node);
      }
    }

    if (ts.isNewExpression(node)) {
      const expression = node.expression.getText(file);
      if (expression === "AbortController") bump("abortController", node);
      if (expression === "Promise") bump("newPromise", node);
      if (expression === "Date" && !fileApproved("globalDate")) bump("globalDate", node);
    }

    if (ts.isPropertyAccessExpression(node)) {
      const expression = node.expression.getText(file);
      if (expression === "process" && node.name.text === "env") bump("processEnv", node);
      if (expression === "console" && !fileApproved("globalConsole")) bump("globalConsole", node);
    }

    if (isEffectGenCall(node, file)) {
      const callback = node.arguments[0];
      if (
        callback &&
        ts.isFunctionLike(callback) &&
        callback.body &&
        callbackHasDirectThrow(callback)
      )
        bump("expectedErrorThrow", callback);
    }

    if (ts.isVariableStatement(node) && hasExportModifier(node) && rawHttpBindings.size > 0) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          initializer &&
          containsBinding(initializer, rawHttpBindings) &&
          !containsLayerProvide(initializer) &&
          !fileApproved("leakedHttpLayer")
        )
          bump("leakedHttpLayer", declaration);
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause) &&
      !fileApproved("leakedHttpLayer")
    ) {
      for (const element of node.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        if (rawHttpBindings.has(local)) bump("leakedHttpLayer", element);
      }
    }

    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression)) {
        if (expression.text === "fetch") bump("globalFetch", node);
        if (
          ["setTimeout", "setInterval", "clearTimeout", "clearInterval"].includes(expression.text)
        )
          bump("rawTimer", node, expression.text);
        const runner = namedEffectRunners.get(expression.text);
        if (runner) {
          const callOwner = `Effect.${runner}`;
          const approved =
            applyProductionAllowlists && exactRunnerAllowlists.get(path)?.has(callOwner) === true;
          if (!approved) bump("effectRunner", node, callOwner);
        }
      } else if (ts.isPropertyAccessExpression(expression)) {
        const property = expression.name.text;
        const owner = expression.expression.getText(file);
        const callOwner = `${owner}.${property}`;
        if (isProperty(expression, "Date", "now") && !fileApproved("globalDate"))
          bump("globalDate", node, callOwner);
        if (
          (isProperty(expression, "JSON", "parse") ||
            isProperty(expression, "JSON", "stringify")) &&
          !fileApproved("rawJson")
        )
          bump("rawJson", node, callOwner);
        if (runnerNames.has(property)) {
          const effectOwner = effectNamespaces.has(owner);
          const managedOwner = managedRuntimeBindings.has(owner);
          if (effectOwner || managedOwner) {
            const canonicalOwner = effectOwner ? `Effect.${property}` : callOwner;
            const approved =
              applyProductionAllowlists &&
              exactRunnerAllowlists.get(path)?.has(canonicalOwner) === true;
            if (!approved) bump("effectRunner", node, canonicalOwner);
          }
        }
        if (property === "bodyJsonUnsafe") bump("bodyJsonUnsafe", node, callOwner);
        if (
          ["Scope", "Ref", "SynchronizedRef", "Deferred", "Fiber"].includes(owner) &&
          property.endsWith("Unsafe")
        )
          bump("unsafeEffectOperation", node, callOwner);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  return violations;
}

async function sourceFiles(directory, options = {}) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        (options.includeFixtures || entry.name !== "fixtures") &&
        (options.includeTestingDirectory || entry.name !== "testing")
      )
        files.push(...(await sourceFiles(path, options)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      if (
        options.includeTests ||
        (!entry.name.endsWith(".spec.ts") && !entry.name.endsWith(".test.ts"))
      )
        files.push(path);
    }
  }
  return files;
}

async function workspacePackageNames() {
  return (await readdir(packageRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function verifyCatalogDependencies(packageName, manifest, packageDirectory) {
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  const imported = new Set();
  for (const path of await sourceFiles(packageDirectory, {
    includeTests: true,
    includeTestingDirectory: true,
  })) {
    const source = await readFile(path, "utf8");
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier === "effect" || specifier.startsWith("effect/")) imported.add("effect");
      if (specifier === "@effect/platform-node" || specifier.startsWith("@effect/platform-node/"))
        imported.add("@effect/platform-node");
      if (specifier === "@effect/vitest" || specifier.startsWith("@effect/vitest/"))
        imported.add("@effect/vitest");
    }
  }
  for (const dependency of imported) {
    if (declared[dependency] !== "catalog:")
      throw new Error(`${packageName} imports ${dependency} but does not declare it as catalog:.`);
  }
}

export async function checkWorkspaceArchitecture() {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const expectedEffectVersion = /\n  effect: ([^\n]+)/.exec(workspace)?.[1];
  const platformVersion = /\n  "@effect\/platform-node": ([^\n]+)/.exec(workspace)?.[1];
  const vitestVersion = /\n  "@effect\/vitest": ([^\n]+)/.exec(workspace)?.[1];
  if (
    !expectedEffectVersion ||
    expectedEffectVersion !== platformVersion ||
    expectedEffectVersion !== vitestVersion
  )
    throw new Error(
      "Effect, @effect/platform-node, and @effect/vitest must use one exact catalog version.",
    );
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedEffectVersion))
    throw new Error(`Effect catalog version must be exact, found ${expectedEffectVersion}.`);

  const packageNames = await workspacePackageNames();
  const violations = [];
  for (const packageName of packageNames) {
    const packageDirectory = join(packageRoot, packageName);
    const config = JSON.parse(await readFile(join(packageDirectory, "tsconfig.json"), "utf8"));
    if (config.extends !== "../../tsconfig.effect.json")
      throw new Error(`${packageName}/tsconfig.json must use the strict Effect configuration.`);
    const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    if (Object.hasOwn(dependencies, "zod"))
      throw new Error(`${packageName} must use Effect Schema instead of Zod.`);
    await verifyCatalogDependencies(packageName, manifest, packageDirectory);

    const src = join(packageDirectory, "src");
    const productionFiles = [join(packageDirectory, "index.ts"), ...(await sourceFiles(src))];
    for (const absolutePath of productionFiles) {
      const path = relative(root, absolutePath);
      violations.push(...scanArchitectureSource(path, await readFile(absolutePath, "utf8")));
    }
  }
  if (violations.length > 0) {
    throw new Error(
      violations
        .map(
          (violation) =>
            `${violation.path}:${violation.line} ${violation.rule}${violation.detail ? ` (${violation.detail})` : ""}`,
        )
        .join("\n"),
    );
  }
  return { packageCount: packageNames.length, expectedEffectVersion };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const result = await checkWorkspaceArchitecture();
  console.log(
    `Effect architecture ratchet verified for ${result.packageCount} packages at ${result.expectedEffectVersion}.`,
  );
}
