import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";

export type FunctionNode =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

export function resolveVariable(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

export function parameterAnnotation(
  parameter: ESTree.ParamPattern,
): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

export function referencedAliasName(type: ESTree.TSType): string | null {
  if (type.type === "TSParenthesizedType") return referencedAliasName(type.typeAnnotation);
  if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") return null;
  return type.typeArguments === null ||
    type.typeArguments === undefined ||
    type.typeArguments.params.length === 0
    ? type.typeName.name
    : null;
}

/** Function values that run, unlike the type-level signatures `FunctionNode` also covers. */
export type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

export function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/** Strip parentheses, optional chains, and type-only wrappers that leave the value unchanged. */
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

/** Quoted tokens are the parser's StringLiteral variant; retain its decoded value. */
export function isStringLiteral(node: ESTree.Node): node is ESTree.StringLiteral {
  return (
    node.type === "Literal" &&
    node.raw !== null &&
    (node.raw.startsWith("'") || node.raw.startsWith('"'))
  );
}

/** A property key's static name: a non-computed identifier or a string literal. */
export function staticPropertyName(key: ESTree.Node, computed: boolean): string | null {
  if (!computed && key.type === "Identifier") return key.name;
  return isStringLiteral(key) ? key.value : null;
}

/** Whether a binding keeps the value it was declared with. */
export function isImmutable(variable: Variable): boolean {
  return !variable.references.some((reference) => reference.isWrite() && !reference.init);
}

/** The declarator of a single, never-reassigned `const` binding, including destructuring. */
export function constDeclarator(variable: Variable): ESTree.VariableDeclarator | null {
  if (variable.defs.length !== 1 || !isImmutable(variable)) return null;
  const definition = variable.defs[0];
  if (definition?.type !== "Variable" || definition.node.type !== "VariableDeclarator") return null;
  const declarator = definition.node;
  return declarator.parent.type === "VariableDeclaration" && declarator.parent.kind === "const"
    ? declarator
    : null;
}

/** The value of a `const name = value` binding; destructured bindings hold only a part of it. */
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

/** A function literal, or one reached through a function declaration or `const` aliases. */
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

/** A value import's module specifier and imported name: `*` for a namespace. */
export interface ImportedValue {
  readonly source: string;
  readonly name: string;
}

/** The value import that declares a binding; type-only imports declare no runtime value. */
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

/**
 * The import an expression names: an imported binding, a static member of an imported
 * namespace, or a `const` alias of either. Never matches by spelling alone.
 */
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
