import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isRuntimeFunction(current)) {
      return current.returnType?.typeAnnotation.type === "TSTypePredicate";
    }
    current = current.parent;
  }
  return false;
}

interface RuntimeTypeofOptions {
  readonly allowInTypeGuards?: boolean;
}

function isRuntimeTypeofOptions<Value>(value: Value): value is Value & RuntimeTypeofOptions {
  return value !== null && Object(value) === value && !Array.isArray(value);
}

/** Return whether typeof safely probes for the existence of a possibly absent binding. */
function isExistenceProbe(node: ESTree.UnaryExpression): boolean {
  const parent = node.parent;
  if (parent.type !== "BinaryExpression") return false;
  if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
  const other = parent.left === node ? parent.right : parent.left;
  return other.type === "Literal" && other.value === "undefined";
}

/** Disallow runtime typeof checks; Effect `Predicate` guards and Schema decoders replace them. */
export const noRuntimeTypeofRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow runtime typeof checks in favor of Effect `Predicate` guards or Schema decoding.",
    },
    messages: {
      runtimeTypeof:
        "Use an Effect `Predicate` guard such as `Predicate.isString` or `Predicate.isFunction` instead of `typeof`. Decode structured external input with Schema at its I/O boundary.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowInTypeGuards: { type: "boolean" },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowInTypeGuards: false }],
  },
  createOnce(context) {
    return {
      UnaryExpression(node) {
        const option = context.options?.[0];
        const allowInTypeGuards =
          isRuntimeTypeofOptions(option) && option.allowInTypeGuards === true;
        if (
          node.operator === "typeof" &&
          !isExistenceProbe(node) &&
          (!allowInTypeGuards || !isInsideTypeGuard(node))
        ) {
          context.report({ node, messageId: "runtimeTypeof" });
        }
      },
    };
  },
});
