import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

import { importedMember, unwrapExpression } from "../../shared/ast.ts";
import { resolveVariable } from "../../shared/scope.ts";

/** Match the global `Boolean`, or `isTruthy` through any lexical alias of `effect/Predicate`. */
const truthinessPredicate = (sourceCode: SourceCode, argument: ESTree.Argument): string | null => {
  if (argument.type === "SpreadElement") return null;
  const predicate = unwrapExpression(argument);
  if (predicate.type === "Identifier" && predicate.name === "Boolean") {
    const variable = resolveVariable(sourceCode, predicate);
    if (variable === null || variable.defs.length === 0) return "Boolean";
  }
  const imported = importedMember(sourceCode, predicate);
  return imported?.source === "effect/Predicate" && imported.name === "isTruthy"
    ? "Predicate.isTruthy"
    : null;
};

/**
 * A truthiness filter also drops `0`, `""`, and `NaN`, and narrows nothing by name. The data-first
 * and data-last forms both take the predicate last.
 */
export const noBooleanFilterRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow `effect/Array` filters that use `Boolean` or `Predicate.isTruthy`.",
    },
    messages: {
      booleanFilter:
        "Do not filter with `{{predicate}}`. Use `Predicate.isString` for optional string parts, `Str.isNonEmpty` for string arrays, or an explicit type predicate that names what it keeps.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const last = node.arguments.at(-1);
        if (last === undefined) return;
        const predicate = truthinessPredicate(context.sourceCode, last);
        if (predicate === null) return;
        const imported = importedMember(context.sourceCode, node.callee);
        if (imported?.source !== "effect/Array" || imported.name !== "filter") return;
        context.report({ node: last, messageId: "booleanFilter", data: { predicate } });
      },
    };
  },
});
