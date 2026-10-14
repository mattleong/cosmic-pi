import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { constValue, importedMember, staticPropertyName, unwrapExpression } from "../shared/ast.ts";
import { resolveVariable } from "../shared/scope.ts";

const moduleMockMethods = new Set(["doMock", "mock", "unstable_mockModule"]);

function isTestFrameworkObject(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): boolean {
  if (depth > 8) return false;
  const binding = importedMember(sourceCode, expression);
  if (binding !== null)
    return (
      ((binding.source === "vitest" || binding.source === "@effect/vitest") &&
        binding.name === "vi") ||
      (binding.source === "@jest/globals" && binding.name === "jest")
    );
  const node = unwrapExpression(expression);
  if (node.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, node);
  if (
    (node.name === "vi" || node.name === "jest") &&
    (variable === null || variable.defs.length === 0)
  )
    return true;
  const init = constValue(sourceCode, node);
  return init !== null && isTestFrameworkObject(sourceCode, init, depth + 1);
}

function moduleMockCall(sourceCode: SourceCode, expression: ESTree.Expression): boolean {
  const callee = unwrapExpression(expression);
  if (callee.type !== "MemberExpression") return false;
  const method = staticPropertyName(callee.property, callee.computed);
  return (
    method !== null &&
    moduleMockMethods.has(method) &&
    isTestFrameworkObject(sourceCode, callee.object)
  );
}

export const noModuleMockingRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Vitest and Jest module mocking; tests must replace dependencies through real interfaces.",
    },
    messages: {
      moduleMock:
        "Replace module mocking with dependency injection through a real interface, service layer, or faithful test implementation.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        if (node.callee.type === "Super" || node.callee.type === "V8IntrinsicExpression") return;
        if (moduleMockCall(context.sourceCode, node.callee)) {
          context.report({ node, messageId: "moduleMock" });
        }
      },
    };
  },
});
