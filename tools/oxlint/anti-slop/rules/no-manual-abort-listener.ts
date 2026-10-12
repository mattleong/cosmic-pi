import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { isStringLiteral, staticPropertyName, unwrapExpression } from "../shared/ast.ts";
import { isWorkspaceFile } from "../shared/workspace-path.ts";

export const abortBoundaryFiles = [
  "packages/pi-cosmic-core/src/runtime/runtime.ts",
  "packages/pi-cosmic-core/src/runtime/session-runtime.ts",
  "packages/pi-cosmic-ui/src/boundary/host-abort-signal.ts",
];

function isAbortEvent(argument: ESTree.Argument | undefined): boolean {
  if (argument === undefined || argument.type === "SpreadElement") return false;
  const event = unwrapExpression(argument);
  if (isStringLiteral(event)) return event.value === "abort";
  return (
    event.type === "TemplateLiteral" &&
    event.expressions.length === 0 &&
    event.quasis[0]?.value.cooked === "abort"
  );
}

export const noManualAbortListenerRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow manual abort listeners outside the shared abort-signal boundaries.",
    },
    messages: {
      manualAbortListener:
        "Do not wire abort handling by hand. Pass the signal to Effect with `runPromise(effect, { signal })`, or use the shared adapter in pi-cosmic-ui `boundary/host-abort-signal.ts`.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return !isWorkspaceFile(context.filename, abortBoundaryFiles);
      },
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (
          callee.type === "MemberExpression" &&
          staticPropertyName(callee.property, callee.computed) === "addEventListener" &&
          isAbortEvent(node.arguments[0])
        )
          context.report({ node, messageId: "manualAbortListener" });
      },
    };
  },
});
