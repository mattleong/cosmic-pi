import type { ESTree } from "@oxlint/plugins";

import { isStringLiteral as isAstStringLiteral } from "../../shared/ast.ts";

const equalityOperators = new Set(["==", "===", "!=", "!=="]);

export const isStringLiteral = (
  node: ESTree.Node | null | undefined,
): node is ESTree.StringLiteral => node !== null && node !== undefined && isAstStringLiteral(node);

// Optional chains (`value?._tag`) wrap the member in a ChainExpression.
const tagMember = (node: ESTree.Node | null | undefined): ESTree.MemberExpression | undefined => {
  const member = node?.type === "ChainExpression" ? node.expression : node;
  if (member?.type !== "MemberExpression") return undefined;
  const { computed, property } = member;
  const isTag =
    (!computed && property.type === "Identifier" && property.name === "_tag") ||
    (computed && isStringLiteral(property) && property.value === "_tag");
  return isTag ? member : undefined;
};

export const isTagMember = (node: ESTree.Node | null | undefined): boolean =>
  tagMember(node) !== undefined;

export const isTagComparison = (node: ESTree.BinaryExpression): boolean =>
  equalityOperators.has(node.operator) &&
  ((isStringLiteral(node.right) && isTagMember(node.left)) ||
    (isStringLiteral(node.left) && isTagMember(node.right)));

export const propertyName = (property: ESTree.ObjectProperty): string | undefined => {
  if (!property.computed && property.key.type === "Identifier") {
    return property.key.name;
  }
  if (isAstStringLiteral(property.key)) {
    return property.key.value;
  }
  return undefined;
};

export const isMatchPatternObject = (node: ESTree.ObjectExpression): boolean => {
  const call = node.parent;
  if (call?.type !== "CallExpression" || !call.arguments.includes(node)) {
    return false;
  }
  const callee = call.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Match" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    (callee.property.name === "when" || callee.property.name === "not")
  );
};

// Effect's own PlatformError constructors take the system error tag as an argument field.
export const isEffectTagArgumentObject = (node: ESTree.ObjectExpression): boolean => {
  const call = node.parent;
  if (
    (call?.type !== "CallExpression" && call?.type !== "NewExpression") ||
    call.arguments[0] !== node
  ) {
    return false;
  }
  const callee = call.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier" ||
    callee.object.name !== "PlatformError" ||
    callee.property.type !== "Identifier"
  ) {
    return false;
  }
  return call.type === "CallExpression"
    ? callee.property.name === "systemError"
    : callee.property.name === "SystemError";
};
