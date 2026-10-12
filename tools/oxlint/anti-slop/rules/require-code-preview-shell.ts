import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constDeclarator,
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
import {
  definitionOrigin,
  objectAssignTarget,
  rendererFields,
  rendererMutationTargets,
} from "../shared/shell-mutations.ts";
import { isWorkspaceFile } from "../shared/workspace-path.ts";

type Mutations = ReadonlySet<NonNullable<ReturnType<typeof definitionOrigin>>>;

const PREVIEWS = "pi-code-previews";
const WRITE_HOOK = `packages/${PREVIEWS}/src/tools/renderers/registration.ts`;
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
  return name !== null && !rendererFields.has(name);
}

function spreadsShellDefinition(
  sourceCode: SourceCode,
  node: ESTree.ObjectExpression,
  mutations: Mutations,
  depth: number,
): boolean {
  const index = node.properties.findLastIndex((property) => property.type === "SpreadElement");
  const spread = node.properties[index];
  return (
    spread?.type === "SpreadElement" &&
    shellDefinition(sourceCode, spread.argument, mutations, depth + 1) &&
    node.properties.slice(index + 1).every(keepsRenderers)
  );
}

function shellDefinition(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  mutations: Mutations,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const origin = definitionOrigin(sourceCode, expression);
  if (origin !== null && mutations.has(origin)) return false;
  const node = unwrapExpression(expression);
  if (node.type === "Identifier") {
    const init = constValue(sourceCode, node);
    return init !== null && shellDefinition(sourceCode, init, mutations, depth + 1);
  }
  if (node.type === "ConditionalExpression")
    return (
      shellDefinition(sourceCode, node.consequent, mutations, depth + 1) &&
      shellDefinition(sourceCode, node.alternate, mutations, depth + 1)
    );
  if (node.type === "ObjectExpression")
    return spreadsShellDefinition(sourceCode, node, mutations, depth);
  if (node.type !== "CallExpression") return false;
  const assigned = objectAssignTarget(sourceCode, node);
  if (assigned !== null) return shellDefinition(sourceCode, assigned, mutations, depth + 1);
  if (shellFunction(sourceCode, node.callee, depth + 1)) return true;
  const helper = resolveFunction(sourceCode, node.callee);
  const value = helper === null ? null : returnedValue(helper);
  return value !== null && shellDefinition(sourceCode, value, mutations, depth + 1);
}

function registrationAlias(
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
  depth: number,
): readonly (ESTree.Expression | ESTree.SpreadElement)[] | null {
  const init = constValue(sourceCode, identifier);
  if (init !== null) return registrationArguments(sourceCode, init, depth + 1);
  const variable = resolveVariable(sourceCode, identifier);
  const declaration = variable === null ? null : constDeclarator(variable);
  if (declaration?.id.type !== "ObjectPattern" || declaration.init === null) return null;
  return declaration.id.properties.some(
    (property) =>
      property.type === "Property" &&
      property.value.type === "Identifier" &&
      property.value.name === identifier.name &&
      staticPropertyName(property.key, property.computed) === "registerTool",
  )
    ? []
    : null;
}

function registrationArguments(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): readonly (ESTree.Expression | ESTree.SpreadElement)[] | null {
  if (depth > MAX_DEPTH) return null;
  const node = unwrapExpression(expression);
  if (node.type === "MemberExpression")
    return staticPropertyName(node.property, node.computed) === "registerTool" ? [] : null;
  if (node.type === "Identifier") return registrationAlias(sourceCode, node, depth);
  if (node.type !== "CallExpression") return null;
  const callee = unwrapExpression(node.callee);
  if (
    callee.type !== "MemberExpression" ||
    staticPropertyName(callee.property, callee.computed) !== "bind"
  )
    return null;
  const bound = registrationArguments(sourceCode, callee.object, depth + 1);
  if (bound === null) return null;
  if (node.arguments[0]?.type === "SpreadElement") return [...bound, node.arguments[0]];
  return [...bound, ...node.arguments.slice(1)];
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
    const calls: ESTree.CallExpression[] = [];
    const writes: ESTree.Node[] = [];
    const check = (node: ESTree.CallExpression, mutations: Mutations) => {
      const bound = registrationArguments(context.sourceCode, node.callee);
      if (bound === null) return;
      const definition = [...bound, ...node.arguments][0];
      if (
        definition !== undefined &&
        definition.type !== "SpreadElement" &&
        shellDefinition(context.sourceCode, definition, mutations)
      )
        return;
      context.report({ node, messageId: "unwrappedTool" });
    };
    return {
      before: () => !exempt(context.filename),
      Program() {
        calls.length = 0;
        writes.length = 0;
      },
      CallExpression(node) {
        calls.push(node);
        writes.push(node);
      },
      AssignmentExpression(node) {
        writes.push(node);
      },
      UpdateExpression(node) {
        writes.push(node);
      },
      UnaryExpression(node) {
        writes.push(node);
      },
      "Program:exit"() {
        const mutations = new Set<NonNullable<ReturnType<typeof definitionOrigin>>>();
        let previousSize: number;
        do {
          previousSize = mutations.size;
          for (const write of writes) {
            for (const target of rendererMutationTargets(context.sourceCode, write, mutations)) {
              const origin = definitionOrigin(context.sourceCode, target);
              if (origin !== null) mutations.add(origin);
            }
          }
        } while (mutations.size !== previousSize);
        for (const call of calls) check(call, mutations);
      },
    };
  },
});
