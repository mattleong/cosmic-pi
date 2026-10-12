import type { ESTree, SourceCode } from "@oxlint/plugins";

import { constValue, resolveFunction, staticPropertyName, unwrapExpression } from "./ast.ts";

export const effectCallbacks = new Set([
  "suspend",
  "tap",
  "tapError",
  "tapCause",
  "flatMap",
  "andThen",
  "catch",
  "catchCause",
  "forEach",
]);
export const valueCallbacks = new Set(["sync", "map", "mapError", "promise", "try", "tryPromise"]);
export const constructors = new Set(["sync", "suspend", "promise", "gen", "try", "tryPromise"]);
export const inputOperators = new Set([
  "asVoid",
  "uninterruptible",
  "interruptible",
  "scoped",
  "orDie",
  "provide",
  "timeout",
]);

export function effectiveObjectValues(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): Map<string, ESTree.Expression> {
  if (depth > 8) return new Map();
  const node = unwrapExpression(expression);
  if (node.type === "Identifier") {
    const init = constValue(sourceCode, node);
    return init === null
      ? new Map<string, ESTree.Expression>()
      : effectiveObjectValues(sourceCode, init, depth + 1);
  }
  const values = new Map<string, ESTree.Expression>();
  if (node.type !== "ObjectExpression") return values;
  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      for (const [key, value] of effectiveObjectValues(sourceCode, property.argument, depth + 1))
        values.set(key, value);
    } else {
      const key = staticPropertyName(property.key, property.computed);
      if (key === null) return new Map();
      values.set(key, property.value);
    }
  }
  return values;
}

export function operationCallback(
  sourceCode: SourceCode,
  method: string,
  args: readonly ESTree.Expression[],
): ESTree.Expression | undefined {
  if (method === "forEach")
    return args[0] !== undefined && resolveFunction(sourceCode, args[0]) !== null
      ? args[0]
      : args[1];
  return constructors.has(method) ? args[0] : args.at(-1);
}

export function tryCallbacks(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): ESTree.Expression[] {
  if (depth > 8) return [];
  const node = unwrapExpression(expression);
  if (resolveFunction(sourceCode, node) !== null) return [node];
  if (node.type === "Identifier") {
    const init = constValue(sourceCode, node);
    return init === null ? [] : tryCallbacks(sourceCode, init, depth + 1);
  }
  if (node.type !== "ObjectExpression") return [];
  return node.properties.flatMap((property) => {
    if (property.type !== "Property") return [];
    const name = staticPropertyName(property.key, property.computed);
    return name === "try" || name === "catch" ? [property.value] : [];
  });
}
