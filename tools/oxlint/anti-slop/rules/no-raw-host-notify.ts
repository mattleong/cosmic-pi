import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { staticPropertyName, unwrapExpression } from "../shared/ast.ts";
import { isWorkspaceFile } from "../shared/workspace-path.ts";

export const notifyBoundaryFiles = [
  "packages/pi-cosmic-core/src/host-session.ts",
  "packages/pi-cosmic-core/src/usage-controller.ts",
];

function memberObject(expression: ESTree.Expression, name: string): ESTree.Expression | null {
  const member = unwrapExpression(expression);
  return member.type === "MemberExpression" &&
    staticPropertyName(member.property, member.computed) === name
    ? member.object
    : null;
}

export const noRawHostNotifyRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct host `ui.notify` calls outside the pi-cosmic-core notification boundary.",
    },
    messages: {
      rawNotify:
        "Route this notification through `notifyAtHostBoundary` from pi-cosmic-core instead of calling `ui.notify` directly.",
    },
  },
  createOnce(context) {
    return {
      before() {
        return !isWorkspaceFile(context.filename, notifyBoundaryFiles);
      },
      CallExpression(node) {
        const ui = memberObject(node.callee, "notify");
        if (ui !== null && memberObject(ui, "ui") !== null)
          context.report({ node, messageId: "rawNotify" });
      },
    };
  },
});
