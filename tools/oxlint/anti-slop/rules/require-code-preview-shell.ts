import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constInitializer,
  constValue,
  importedMember,
  isImmutable,
  resolveFunction,
  resolveVariable,
  returnedValue,
  staticPropertyName,
  unwrapExpression,
} from "../shared/ast.ts";
import { isWorkspaceFile } from "../shared/workspace-path.ts";

const PREVIEWS = "pi-code-previews";
const WRITE_HOOK = `packages/${PREVIEWS}/src/tools/renderers/registration.ts`;
const RENDERER_FIELDS = new Set(["renderShell", "renderCall", "renderResult"]);
const MAX_DEPTH = 8;

function exempt(filename: string): boolean {
  return (
    isWorkspaceFile(filename, [WRITE_HOOK]) || filename.replaceAll("\\", "/").includes("/tests/")
  );
}

function previewsExport(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  name: string,
): boolean {
  const binding = importedMember(sourceCode, expression);
  return (
    binding?.name === name &&
    (binding.source === PREVIEWS || binding.source.startsWith(`${PREVIEWS}/`))
  );
}

function replayHandle(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const node = unwrapExpression(expression);
  if (node.type === "CallExpression")
    return previewsExport(sourceCode, node.callee, "registerCodePreviewReplay");
  if (node.type !== "Identifier") return false;
  const init = constValue(sourceCode, node);
  return init !== null && replayHandle(sourceCode, init, depth + 1);
}

function parameterShell(sourceCode: SourceCode, variable: Variable, depth: number): boolean {
  const parameter = variable.defs.find((definition) => definition.type === "Parameter");
  if (parameter === undefined) return false;
  const { name } = parameter;
  if (
    name.parent.type === "AssignmentPattern" &&
    name.parent.left === name &&
    shellFunction(sourceCode, name.parent.right, depth + 1)
  )
    return true;
  const annotation = name.typeAnnotation?.typeAnnotation;
  return (
    annotation?.type === "TSTypeQuery" &&
    annotation.exprName.type === "Identifier" &&
    previewsExport(sourceCode, annotation.exprName, "withCodePreviewShell")
  );
}

function shellFunction(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const node = unwrapExpression(expression);
  if (previewsExport(sourceCode, node, "withCodePreviewShell")) return true;
  if (node.type === "MemberExpression")
    return (
      staticPropertyName(node.property, node.computed) === "shell" &&
      replayHandle(sourceCode, node.object, depth + 1)
    );
  if (node.type !== "Identifier") return false;
  const variable = resolveVariable(sourceCode, node);
  if (variable === null || !isImmutable(variable)) return false;
  const init = constInitializer(variable);
  if (init !== null) return shellFunction(sourceCode, init, depth + 1);
  return parameterShell(sourceCode, variable, depth);
}

function keepsRenderers(property: ESTree.ObjectPropertyKind): boolean {
  if (property.type !== "Property") return false;
  const name = staticPropertyName(property.key, property.computed);
  return name !== null && !RENDERER_FIELDS.has(name);
}

function spreadsShellDefinition(
  sourceCode: SourceCode,
  node: ESTree.ObjectExpression,
  depth: number,
): boolean {
  const index = node.properties.findLastIndex((property) => property.type === "SpreadElement");
  const spread = node.properties[index];
  return (
    spread?.type === "SpreadElement" &&
    shellDefinition(sourceCode, spread.argument, depth + 1) &&
    node.properties.slice(index + 1).every(keepsRenderers)
  );
}

function shellDefinition(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const node = unwrapExpression(expression);
  if (node.type === "Identifier") {
    const init = constValue(sourceCode, node);
    return init !== null && shellDefinition(sourceCode, init, depth + 1);
  }
  if (node.type === "ConditionalExpression")
    return (
      shellDefinition(sourceCode, node.consequent, depth + 1) &&
      shellDefinition(sourceCode, node.alternate, depth + 1)
    );
  if (node.type === "ObjectExpression") return spreadsShellDefinition(sourceCode, node, depth);
  if (node.type !== "CallExpression") return false;
  if (shellFunction(sourceCode, node.callee, depth + 1)) return true;
  const helper = resolveFunction(sourceCode, node.callee);
  const value = helper === null ? null : returnedValue(helper);
  return value !== null && shellDefinition(sourceCode, value, depth + 1);
}

export const requireCodePreviewShellRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require workspace-owned tools to be registered through the Code Previews shell.",
    },
    messages: {
      unwrappedTool:
        "Register this tool through withCodePreviewShell or the registerCodePreviewReplay shell so Code Previews owns its presentation.",
    },
  },
  createOnce(context) {
    return {
      before: () => !exempt(context.filename),
      CallExpression(node) {
        const callee = unwrapExpression(node.callee);
        if (
          callee.type !== "MemberExpression" ||
          staticPropertyName(callee.property, callee.computed) !== "registerTool"
        )
          return;
        const definition = node.arguments[0];
        if (
          definition !== undefined &&
          definition.type !== "SpreadElement" &&
          shellDefinition(context.sourceCode, definition)
        )
          return;
        context.report({ node, messageId: "unwrappedTool" });
      },
    };
  },
});
