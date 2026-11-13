import { defineRule } from "@oxlint/plugins";

import { importedMember, unwrapExpression } from "../../shared/ast.ts";

/**
 * Enforce the String call style: a data-last `Str.op(args)` is a pipeline step, never a function
 * to call on the spot.
 */
export const noCurriedStringCallRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow calling a curried `effect/String` operation directly on its text.",
    },
    messages: {
      curriedStringCall:
        "Do not call the curried `{{name}}` directly. Call it data-first as `Str.{{name}}(text, ...)` when its API offers that form, and otherwise as `Fn.pipe(text, Str.{{name}}(...))`.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const step = unwrapExpression(node.callee);
        if (step.type !== "CallExpression") return;
        const imported = importedMember(context.sourceCode, step.callee);
        if (imported?.source !== "effect/String" || imported.name === "*") return;
        context.report({ node, messageId: "curriedStringCall", data: { name: imported.name } });
      },
    };
  },
});
