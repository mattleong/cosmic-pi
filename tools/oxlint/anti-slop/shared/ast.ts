import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { resolveVariable } from "./scope.ts";

export type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

export function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

export function unwrapExpression(expression: ESTree.Expression): ESTree.Expression {
  let current = expression;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSInstantiationExpression" ||
    current.type === "ChainExpression"
  )
    current = current.expression;
  return current;
}

export function isStringLiteral(node: ESTree.Node): node is ESTree.StringLiteral {
  return (
    node.type === "Literal" &&
    node.raw !== null &&
    (node.raw.startsWith("'") || node.raw.startsWith('"'))
  );
}

export function staticPropertyName(key: ESTree.Node, computed: boolean): string | null {
  if (!computed && key.type === "Identifier") return key.name;
  return isStringLiteral(key) ? key.value : null;
}

export function isImmutable(variable: Variable): boolean {
  return !variable.references.some((reference) => reference.isWrite() && !reference.init);
}

export function constDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  if (variable.defs.length !== 1 || !isImmutable(variable)) return null;
  const definition = variable.defs[0];
  if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator") return null;
  const declarator = definition.node;
  return declarator.parent.type === "VariableDeclaration" && declarator.parent.kind === "const"
    ? declarator
    : null;
}

export function constInitializer(variable: Variable): ESTree.Expression | null {
  const declarator = constDeclarator(variable);
  return declarator?.id.type === "Identifier" ? declarator.init : null;
}

export function constValue(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): ESTree.Expression | null {
  const variable = resolveVariable(sourceCode, identifier);
  return variable === null ? null : constInitializer(variable);
}

export function resolveFunction(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  seen = new Set<Variable>(),
): RuntimeFunction | null {
  const value = unwrapExpression(expression);
  if (isRuntimeFunction(value)) return value;
  if (value.type !== "Identifier") return null;
  const variable = resolveVariable(sourceCode, value);
  if (variable === null || seen.has(variable) || !isImmutable(variable)) return null;
  seen.add(variable);
  const definition = variable.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type === "FunctionName" && definition.node.type === "FunctionDeclaration")
    return definition.node;
  const init = constInitializer(variable);
  return init === null ? null : resolveFunction(sourceCode, init, seen);
}

export function returnedValue(fn: RuntimeFunction): ESTree.Expression | null {
  if (fn.body === null) return null;
  if (fn.body.type !== "BlockStatement") return fn.body;
  const statements = fn.body.body;
  const last = statements.at(-1);
  return last?.type === "ReturnStatement" &&
    statements.slice(0, -1).every((statement) => statement.type === "VariableDeclaration")
    ? last.argument
    : null;
}

export interface ImportedValue {
  readonly source: string;
  readonly name: string;
}

export function importedValue(variable: Variable): ImportedValue | null {
  for (const definition of variable.defs) {
    if (definition.type !== "ImportBinding" || definition.parent?.type !== "ImportDeclaration")
      continue;
    const declaration = definition.parent;
    const specifier = definition.node;
    if (declaration.importKind === "type") return null;
    const source = declaration.source.value;
    if (specifier.type === "ImportNamespaceSpecifier") return { source, name: "*" };
    if (specifier.type === "ImportDefaultSpecifier") return { source, name: "default" };
    if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") return null;
    const { imported } = specifier;
    return { source, name: imported.type === "Identifier" ? imported.name : imported.value };
  }
  return null;
}

export function importedMember(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  seen = new Set<Variable>(),
): ImportedValue | null {
  const value = unwrapExpression(expression);
  if (value.type === "MemberExpression") {
    const name = staticPropertyName(value.property, value.computed);
    if (name === null) return null;
    const namespace = importedMember(sourceCode, value.object, seen);
    return namespace?.name === "*" ? { source: namespace.source, name } : null;
  }
  if (value.type !== "Identifier") return null;
  const variable = resolveVariable(sourceCode, value);
  if (variable === null || seen.has(variable)) return null;
  seen.add(variable);
  const imported = importedValue(variable);
  if (imported !== null) return imported;
  const init = constInitializer(variable);
  return init === null ? null : importedMember(sourceCode, init, seen);
}
