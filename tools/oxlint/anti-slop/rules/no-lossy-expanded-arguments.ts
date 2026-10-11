import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constValue,
  importedMember,
  isImmutable,
  isRuntimeFunction,
  resolveVariable,
  staticPropertyName,
  unwrapExpression,
  type RuntimeFunction,
} from "../shared/ast.ts";

function imported(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  source: string,
  name: string,
): boolean {
  const binding = importedMember(sourceCode, expression);
  return binding?.source === source && binding.name === name;
}

function renderCall(node: RuntimeFunction): boolean {
  return (
    node.parent.type === "Property" &&
    staticPropertyName(node.parent.key, node.parent.computed) === "renderCall"
  );
}

function functionBinding(sourceCode: SourceCode, node: RuntimeFunction): Variable | null {
  const declaration = node.parent.type === "VariableDeclarator" ? node.parent : node;
  return (
    sourceCode
      .getDeclaredVariables(declaration)
      .find((variable) =>
        variable.defs.some(
          (definition) => definition.type === "Variable" || definition.type === "FunctionName",
        ),
      ) ?? null
  );
}

/** Only a renderer's whole input, or its input passed directly to one local helper. */
function exactArguments(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
  helpers = 1,
): boolean {
  if (depth > 12) return false;
  const node = unwrapExpression(expression);
  if (
    node.type === "LogicalExpression" &&
    node.operator === "??" &&
    node.right.type === "Literal" &&
    node.right.value === null
  ) {
    return exactArguments(sourceCode, node.left, depth + 1, helpers);
  }
  if (node.type !== "Identifier") return false;
  const initializer = constValue(sourceCode, node);
  if (initializer !== null) return exactArguments(sourceCode, initializer, depth + 1, helpers);
  const variable = resolveVariable(sourceCode, node);
  if (variable === null || !isImmutable(variable)) return false;
  const parameter = variable.defs.find((definition) => definition.type === "Parameter");
  if (parameter === undefined || !isRuntimeFunction(parameter.node)) return false;
  const fn = parameter.node;
  const index = fn.params.findIndex(
    (param) => param.type === "Identifier" && param.name === node.name,
  );
  if (index < 0) return false;
  if (renderCall(fn)) return index === 0;
  if (helpers === 0) return false;
  const binding = functionBinding(sourceCode, fn);
  if (binding === null || !isImmutable(binding)) return false;
  return binding.references.some(({ identifier }) => {
    const call = identifier.parent;
    if (call.type !== "CallExpression" || call.callee !== identifier) return false;
    const argument = call.arguments[index];
    return (
      argument !== undefined &&
      argument.type !== "SpreadElement" &&
      exactArguments(sourceCode, argument, depth + 1, helpers - 1)
    );
  });
}

function returned(node: ESTree.Expression): ESTree.Expression | null {
  const fn = unwrapExpression(node);
  if (!isRuntimeFunction(fn) || fn.body === null) return null;
  if (fn.body.type !== "BlockStatement") return fn.body;
  const statements = fn.body.body;
  const last = statements.at(-1);
  return last?.type === "ReturnStatement" &&
    statements.slice(0, -1).every((statement) => statement.type === "VariableDeclaration")
    ? last.argument
    : null;
}

function serializedArguments(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): boolean {
  if (depth > 12) return false;
  const node = unwrapExpression(expression);
  if (node.type === "Identifier") {
    const initializer = constValue(sourceCode, node);
    return initializer !== null && serializedArguments(sourceCode, initializer, depth + 1);
  }
  if (
    node.type === "LogicalExpression" &&
    (node.operator === "??" || node.operator === "||") &&
    node.right.type === "Literal" &&
    node.right.value === ""
  ) {
    return serializedArguments(sourceCode, node.left, depth + 1);
  }
  if (node.type !== "CallExpression") return false;
  const callee = unwrapExpression(node.callee);
  if (imported(sourceCode, callee, "pi-cosmic-core", "invokeHostCallback")) {
    const callback = node.arguments[0];
    const value =
      callback !== undefined && callback.type !== "SpreadElement" ? returned(callback) : null;
    return value !== null && serializedArguments(sourceCode, value, depth + 1);
  }
  const input = node.arguments[0];
  const replacer = node.arguments[1];
  if (
    replacer !== undefined &&
    !(replacer.type === "Literal" && replacer.value === null) &&
    !(
      replacer.type === "Identifier" &&
      replacer.name === "undefined" &&
      (resolveVariable(sourceCode, replacer)?.defs.length ?? 0) === 0
    )
  )
    return false;
  return (
    callee.type === "MemberExpression" &&
    staticPropertyName(callee.property, callee.computed) === "stringify" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "JSON" &&
    (resolveVariable(sourceCode, callee.object)?.defs.length ?? 0) === 0 &&
    input !== undefined &&
    input.type !== "SpreadElement" &&
    exactArguments(sourceCode, input)
  );
}

/** Follow only expression ancestry and immutable text aliases, not arbitrary renderer helpers. */
function renderingSink(sourceCode: SourceCode, node: ESTree.Node, depth = 0): boolean {
  if (depth > 12) return false;
  for (
    let child = node, parent = node.parent;
    parent !== null;
    child = parent, parent = parent.parent
  ) {
    // Conditions and discarded sequence values do not supply the rendered text.
    if (
      (parent.type === "ConditionalExpression" && parent.test === child) ||
      (parent.type === "SequenceExpression" && parent.expressions.at(-1) !== child)
    )
      return false;
    if (
      parent.type === "NewExpression" &&
      parent.arguments.some((argument) => argument === child) &&
      imported(sourceCode, parent.callee, "@earendil-works/pi-tui", "Text")
    )
      return true;
    if (
      parent.type === "VariableDeclarator" &&
      parent.init === child &&
      parent.id.type === "Identifier"
    ) {
      const variable = sourceCode.getDeclaredVariables(parent)[0];
      return (
        parent.parent.type === "VariableDeclaration" &&
        parent.parent.kind === "const" &&
        variable !== undefined &&
        isImmutable(variable) &&
        variable.references.some(
          (reference) =>
            reference.isRead() && renderingSink(sourceCode, reference.identifier, depth + 1),
        )
      );
    }
    if (parent.type === "ReturnStatement") {
      let owner = parent.parent;
      while (!isRuntimeFunction(owner) && owner.parent !== null) owner = owner.parent;
      return isRuntimeFunction(owner) && renderCall(owner);
    }
    if (isRuntimeFunction(parent)) return parent.body === child && renderCall(parent);
    if (
      parent.type === "ExpressionStatement" ||
      parent.type === "BlockStatement" ||
      parent.type === "Program"
    )
      return false;
  }
  return false;
}

/** Exact expanded inputs must escape controls visibly, never delete them. */
export const noLossyExpandedArgumentsRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow lossy terminal sanitization of serialized renderer arguments." },
    messages: {
      lossyArguments:
        "Preserve exact expanded arguments with expandedArguments or visible control escaping instead of stripTerminalControls.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const input = node.arguments[0];
        if (input === undefined || input.type === "SpreadElement") return;
        if (
          imported(context.sourceCode, node.callee, "pi-cosmic-core", "stripTerminalControls") &&
          serializedArguments(context.sourceCode, input) &&
          renderingSink(context.sourceCode, node)
        ) {
          context.report({ node, messageId: "lossyArguments" });
        }
      },
    };
  },
});
