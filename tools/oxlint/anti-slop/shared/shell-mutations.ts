import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import { constValue, resolveVariable, staticPropertyName, unwrapExpression } from "./ast.ts";

export const rendererFields = new Set(["renderShell", "renderCall", "renderResult"]);

type Origin = ESTree.Expression | Variable;

export type RendererMutations = ReadonlySet<Origin>;

export function objectAssignTarget(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): ESTree.Expression | null {
  const node = unwrapExpression(expression);
  if (node.type !== "CallExpression") return null;
  const callee = unwrapExpression(node.callee);
  if (
    callee.type !== "MemberExpression" ||
    staticPropertyName(callee.property, callee.computed) !== "assign" ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "Object"
  )
    return null;
  const variable = resolveVariable(sourceCode, callee.object);
  if (variable !== null && variable.defs.length !== 0) return null;
  const target = node.arguments[0];
  return target === undefined || target.type === "SpreadElement" ? null : target;
}

export function definitionOrigin(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): Origin | null {
  if (depth > 8) return null;
  const node = unwrapExpression(expression);
  if (node.type === "Identifier") {
    const init = constValue(sourceCode, node);
    return init === null
      ? resolveVariable(sourceCode, node)
      : definitionOrigin(sourceCode, init, depth + 1);
  }
  const target = objectAssignTarget(sourceCode, node);
  return target === null ? node : definitionOrigin(sourceCode, target, depth + 1);
}

function rendererTarget(member: ESTree.MemberExpression): ESTree.Expression | null {
  const name = staticPropertyName(member.property, member.computed);
  return name === null || rendererFields.has(name) ? member.object : null;
}

function assignmentTargets(target: ESTree.Node): ESTree.Expression[] {
  if (target.type === "MemberExpression") {
    const object = rendererTarget(target);
    return object === null ? [] : [object];
  }
  if (target.type === "ArrayPattern")
    return target.elements.flatMap((element) =>
      element === null ? [] : assignmentTargets(element),
    );
  if (target.type === "ObjectPattern")
    return target.properties.flatMap((property) =>
      assignmentTargets(property.type === "Property" ? property.value : property.argument),
    );
  if (target.type === "ParenthesizedExpression" || target.type === "TSNonNullExpression")
    return assignmentTargets(target.expression);
  if (target.type === "AssignmentPattern") return assignmentTargets(target.left);
  if (target.type === "RestElement") return assignmentTargets(target.argument);
  return [];
}

function keepsRendererFields(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  mutations: RendererMutations,
  depth = 0,
): boolean {
  if (depth > 8) return false;
  const origin = definitionOrigin(sourceCode, expression);
  if (origin !== null && mutations.has(origin)) return false;
  const node = unwrapExpression(expression);
  if (node.type === "Identifier") {
    const init = constValue(sourceCode, node);
    return init !== null && keepsRendererFields(sourceCode, init, mutations, depth + 1);
  }
  if (node.type !== "ObjectExpression") return false;
  return node.properties.every((property) => {
    if (property.type === "SpreadElement")
      return keepsRendererFields(sourceCode, property.argument, mutations, depth + 1);
    const name = staticPropertyName(property.key, property.computed);
    return name !== null && !rendererFields.has(name);
  });
}

export function rendererMutationTargets(
  sourceCode: SourceCode,
  node: ESTree.Node,
  mutations: RendererMutations,
): ESTree.Expression[] {
  if (node.type === "AssignmentExpression") return assignmentTargets(node.left);
  if (node.type === "UpdateExpression") return assignmentTargets(node.argument);
  if (node.type === "UnaryExpression" && node.operator === "delete")
    return assignmentTargets(node.argument);
  if (node.type !== "CallExpression") return [];
  const target = objectAssignTarget(sourceCode, node);
  if (target === null) return [];
  const sources = node.arguments.slice(1);
  const safe = sources.every(
    (source) =>
      source.type !== "SpreadElement" && keepsRendererFields(sourceCode, source, mutations),
  );
  return safe ? [] : [target];
}
