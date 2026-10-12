import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constValue,
  importedMember,
  isImmutable,
  isRuntimeFunction,
  isStringLiteral,
  resolveFunction,
  resolveVariable,
  staticPropertyName,
  unwrapExpression,
  type RuntimeFunction,
} from "../shared/ast.ts";

const vitestSources = new Set(["vitest", "@effect/vitest"]);
const matchers = new Set(["toContain", "toMatch", "toBe", "toEqual"]);
const modifiers = new Set([
  "only",
  "skip",
  "todo",
  "concurrent",
  "sequential",
  "fails",
  "each",
  "for",
  "skipIf",
  "runIf",
  "effect",
  "scoped",
  "live",
  "scopedLive",
  "flakyTest",
  "prop",
]);

const typecheckFile = (filename: string): boolean =>
  /\.(?:test|spec)-d\.[cm]?[jt]sx?$/u.test(filename);

function memberName(node: ESTree.MemberExpression): string | null {
  return staticPropertyName(node.property, node.computed);
}

function importedName(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  sources: ReadonlySet<string>,
): string | null {
  const binding = importedMember(sourceCode, expression);
  return binding !== null && binding.name !== "*" && sources.has(binding.source)
    ? binding.name
    : null;
}

function frameworkName(sourceCode: SourceCode, expression: ESTree.Expression): string | null {
  const name = importedName(sourceCode, expression, vitestSources);
  if (name !== null) return name;
  const node = unwrapExpression(expression);
  return node.type === "Identifier" &&
    (node.name === "it" ||
      node.name === "test" ||
      node.name === "describe" ||
      node.name === "expect") &&
    globalReference(sourceCode, node)
    ? node.name
    : null;
}

function registration(sourceCode: SourceCode, expression: ESTree.Expression): string | null {
  const name = frameworkName(sourceCode, expression);
  if (name === "it" || name === "test" || name === "describe") return name;
  const node = unwrapExpression(expression);
  if (node.type === "CallExpression") return registration(sourceCode, node.callee);
  if (node.type !== "MemberExpression") return null;
  const modifier = memberName(node);
  return modifier !== null && modifiers.has(modifier)
    ? registration(sourceCode, node.object)
    : null;
}

function runtimeTest(sourceCode: SourceCode, node: ESTree.Node): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (!isRuntimeFunction(parent) || parent.parent.type !== "CallExpression") continue;
    const call = parent.parent;
    if (!call.arguments.some((argument) => argument === parent)) continue;
    const owner = registration(sourceCode, call.callee);
    if (owner === "it" || owner === "test") return true;
  }
  return false;
}

function globalReference(sourceCode: SourceCode, node: ESTree.IdentifierReference): boolean {
  const variable = resolveVariable(sourceCode, node);
  return variable === null || variable.defs.length === 0;
}

const fsSources = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"]);

function filesystemNamespace(sourceCode: SourceCode, node: ESTree.IdentifierReference): boolean {
  const binding = importedMember(sourceCode, node);
  return (
    binding !== null &&
    fsSources.has(binding.source) &&
    (binding.name === "*" || binding.name === "default")
  );
}

function filesystem(sourceCode: SourceCode, expression: ESTree.Expression, depth = 0): boolean {
  if (depth > 8) return false;
  const node = unwrapExpression(expression);
  if (node.type === "Identifier") {
    if (filesystemNamespace(sourceCode, node)) return true;
    const value = constValue(sourceCode, node);
    return value !== null && filesystem(sourceCode, value, depth + 1);
  }
  return node.type === "CallExpression" && builtinFilesystemModule(sourceCode, node);
}

function builtinFilesystemModule(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
  if (node.callee.type !== "MemberExpression") return false;
  const { object } = node.callee;
  const module = node.arguments[0];
  return (
    memberName(node.callee) === "getBuiltinModule" &&
    object.type === "Identifier" &&
    object.name === "process" &&
    globalReference(sourceCode, object) &&
    module !== undefined &&
    isStringLiteral(module) &&
    fsSources.has(module.value)
  );
}

function reader(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const name = importedName(sourceCode, expression, fsSources);
  if (name === "readFile" || name === "readFileSync") return true;
  const node = unwrapExpression(expression);
  return (
    node.type === "MemberExpression" &&
    (memberName(node) === "readFile" || memberName(node) === "readFileSync") &&
    filesystem(sourceCode, node.object)
  );
}

function returned(fn: RuntimeFunction): ESTree.Expression | null {
  if (fn.body === null) return null;
  if (fn.body.type !== "BlockStatement") return fn.body;
  return fn.body.body.length === 1 && fn.body.body[0]?.type === "ReturnStatement"
    ? fn.body.body[0].argument
    : null;
}

type Substitutions = ReadonlyMap<Variable, ESTree.Expression>;

function pathText(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  substitutions: Substitutions,
  depth = 0,
): string | null {
  if (depth > 12) return null;
  const node = unwrapExpression(expression);
  if (isStringLiteral(node)) return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  const source = pathSource(sourceCode, node, substitutions);
  return source === null ? null : pathText(sourceCode, source, substitutions, depth + 1);
}

function pathSource(
  sourceCode: SourceCode,
  node: ESTree.Expression,
  substitutions: Substitutions,
): ESTree.Expression | null {
  if (node.type === "Identifier") {
    const variable = resolveVariable(sourceCode, node);
    return variable === null ? null : (substitutions.get(variable) ?? constValue(sourceCode, node));
  }
  if (
    node.type !== "NewExpression" ||
    node.callee.type !== "Identifier" ||
    node.callee.name !== "URL" ||
    !globalReference(sourceCode, node.callee)
  )
    return null;
  const path = node.arguments[0];
  return path !== undefined && path.type !== "SpreadElement" ? path : null;
}

function productionPath(path: string | null): boolean {
  return (
    path !== null &&
    /(?:^|\/)src\/.+\.(?:[cm]?[jt]sx?)$/.test(path) &&
    !/(?:^|\/)(?:tests?|__tests__|fixtures?|__fixtures__)\//.test(path)
  );
}

function parameterBindings(
  sourceCode: SourceCode,
  fn: RuntimeFunction,
  call: ESTree.CallExpression,
  substitutions: Substitutions,
): Substitutions {
  const bindings = new Map(substitutions);
  const parameters = sourceCode.getDeclaredVariables(fn);
  for (let index = 0; index < fn.params.length; index++) {
    const parameter = fn.params[index];
    const argument = call.arguments[index];
    if (
      parameter?.type !== "Identifier" ||
      argument === undefined ||
      argument.type === "SpreadElement"
    )
      continue;
    const variable = parameters.find(
      (candidate) =>
        candidate.name === parameter.name &&
        candidate.defs.some((entry) => entry.type === "Parameter"),
    );
    if (variable !== undefined && isImmutable(variable)) bindings.set(variable, argument);
  }
  return bindings;
}

function readsProductionPath(
  sourceCode: SourceCode,
  call: ESTree.CallExpression,
  substitutions: Substitutions,
): boolean {
  const path = call.arguments[0];
  return (
    path !== undefined &&
    path.type !== "SpreadElement" &&
    productionPath(pathText(sourceCode, path, substitutions))
  );
}

function sourceText(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  substitutions: Substitutions = new Map(),
  depth = 0,
  wrappers = 1,
): boolean {
  if (depth > 12) return false;
  const node = unwrapExpression(expression);
  if (node.type === "AwaitExpression")
    return sourceText(sourceCode, node.argument, substitutions, depth + 1, wrappers);
  if (node.type === "Identifier") {
    const value = constValue(sourceCode, node);
    return value !== null && sourceText(sourceCode, value, substitutions, depth + 1, wrappers);
  }
  if (node.type !== "CallExpression") return false;
  if (reader(sourceCode, node.callee)) return readsProductionPath(sourceCode, node, substitutions);
  if (wrappers === 0 || node.callee.type !== "Identifier") return false;
  const fn = resolveFunction(sourceCode, node.callee);
  if (fn === null) return false;
  const result = returned(fn);
  if (result === null) return false;
  const bindings = parameterBindings(sourceCode, fn, node, substitutions);
  return sourceText(sourceCode, result, bindings, depth + 1, wrappers - 1);
}

function spellingAssertion(expression: ESTree.Expression): boolean {
  const node = unwrapExpression(expression);
  const text = isStringLiteral(node)
    ? node.value
    : node.type === "Literal" && "regex" in node
      ? node.regex.pattern
      : node.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0]?.value.cooked
        : null;
  return (
    text !== null &&
    text !== undefined &&
    (/\bfrom\s+["']/.test(text) ||
      /\bimport\s*(?:["'{*])/.test(text) ||
      /\b(?:interface|type|class|function|const|let|var)\s+[A-Za-z_$]/.test(text))
  );
}

function sourceSpellingTest(sourceCode: SourceCode, node: ESTree.CallExpression): boolean {
  const callee = unwrapExpression(node.callee);
  if (callee.type !== "MemberExpression" || !matchers.has(memberName(callee) ?? "")) return false;
  let subject = callee.object;
  if (subject.type === "MemberExpression" && memberName(subject) === "not")
    subject = subject.object;
  if (subject.type !== "CallExpression" || frameworkName(sourceCode, subject.callee) !== "expect")
    return false;
  const actual = subject.arguments[0];
  const expected = node.arguments[0];
  return (
    actual !== undefined &&
    actual.type !== "SpreadElement" &&
    expected !== undefined &&
    expected.type !== "SpreadElement" &&
    spellingAssertion(expected) &&
    sourceText(sourceCode, actual)
  );
}

export const noRuntimeTypeOnlyTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow erased type checks in runtime tests and raw production-source spelling assertions.",
    },
    messages: {
      runtimeTypeCheck:
        "Move erased type assertions to top-level type checks or a Vitest `*.test-d.ts` typecheck file; runtime tests should assert behavior.",
      sourceSpelling:
        "Test production behavior or module execution instead of import or declaration spellings in raw source text.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const name = importedName(context.sourceCode, node.callee, vitestSources);
        if (
          (name === "expectTypeOf" || name === "assertType") &&
          !typecheckFile(context.filename) &&
          runtimeTest(context.sourceCode, node)
        ) {
          context.report({ node, messageId: "runtimeTypeCheck" });
        } else if (sourceSpellingTest(context.sourceCode, node)) {
          context.report({ node, messageId: "sourceSpelling" });
        }
      },
    };
  },
});
