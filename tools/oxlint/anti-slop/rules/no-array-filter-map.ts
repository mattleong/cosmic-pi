import { defineRule } from "@oxlint/plugins";

import {
  arrayMethodTarget,
  isKnownArrayExpression,
  unwrapArrayExpression,
} from "../shared/array-method.ts";

/** Reject adjacent array filter/map passes in favor of one Effect `Array` transformation. */
export const noArrayFilterMapRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow adjacent array filter/map passes in favor of a single `effect/Array` transformation.",
    },
    messages: {
      arrayFilterMap:
        "Avoid consecutive array `{{first}}` and `{{second}}` passes. Use one `effect/Array` pass: `Array.filterMap(items, (item) => ... ? Result.succeed(value) : Result.failVoid)`, `Array.partition` to keep both sides, or `Array.getSomes` for Options; reserve `flatMap` for elements that yield several values. Preserve callback ordering, indexes, and filtering semantics.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const outer = arrayMethodTarget(node.callee);
        if (outer === null || (outer.name !== "map" && outer.name !== "filter")) return;
        const innerCall = unwrapArrayExpression(outer.object);
        if (innerCall.type !== "CallExpression") return;
        const inner = arrayMethodTarget(innerCall.callee);
        if (inner === null || inner.name !== (outer.name === "map" ? "filter" : "map")) return;
        if (!isKnownArrayExpression(context.sourceCode, inner.object)) return;
        context.report({
          node,
          messageId: "arrayFilterMap",
          data: { first: inner.name, second: outer.name },
        });
      },
    };
  },
});
