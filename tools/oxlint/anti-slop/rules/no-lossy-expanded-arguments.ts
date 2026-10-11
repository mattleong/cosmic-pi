import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constValue,
  importedMember,
  isImmutable,
  isRuntimeFunction,
  isStringLiteral,
  resolveVariable,
  returnedValue,
  staticPropertyName,
  unwrapExpression,
  type RuntimeFunction,
} from "../shared/ast.ts";

const CORE = "pi-cosmic-core";
const DESTRUCTIVE = new Set(["stripTerminalControls", "stripAnsi"]);
const STYLED_TEXT = new Map([
  ["fg", 1],
  ["bg", 1],
  ["bold", 0],
]);
const MAX_DEPTH = 12;

function testFile(filename: string): boolean {
  return filename.replaceAll("\\", "/").includes("/tests/");
}

type RendererRole = "renderCall" | "renderResult";
type Step = boolean | "next";

function imported(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  source: string,
  name: string,
): boolean {
  const binding = importedMember(sourceCode, expression);
  return binding?.source === source && binding.name === name;
}

function destructiveSanitizer(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
): string | null {
  const binding = importedMember(sourceCode, expression);
  return binding?.source === CORE && DESTRUCTIVE.has(binding.name) ? binding.name : null;
}

const VALUE_WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

function passesValue(parent: ESTree.Node, child: ESTree.Node): boolean {
  if (VALUE_WRAPPERS.has(parent.type)) return true;
  if (parent.type === "ConditionalExpression") return parent.test !== child;
  if (parent.type === "LogicalExpression")
    return parent.operator !== "&&" || parent.right === child;
  return parent.type === "SequenceExpression" && parent.expressions.at(-1) === child;
}

function carriesText(parent: ESTree.Node, child: ESTree.Node): boolean {
  if (parent.type === "TemplateLiteral") return true;
  if (parent.type === "BinaryExpression") return parent.operator === "+";
  return passesValue(parent, child);
}

function holderOf(node: ESTree.Node): ESTree.Node {
  let holder = node;
  while (holder.parent !== null && passesValue(holder.parent, holder)) holder = holder.parent;
  return holder;
}

function propertyRole(node: ESTree.Node, value: ESTree.Node): RendererRole | null {
  if (node.type !== "Property" || node.value !== value) return null;
  const name = staticPropertyName(node.key, node.computed);
  return name === "renderCall" || name === "renderResult" ? name : null;
}

function functionBinding(sourceCode: SourceCode, node: RuntimeFunction): Variable | null {
  const holder = holderOf(node);
  const declaration =
    holder.parent?.type === "VariableDeclarator" && holder.parent.init === holder
      ? holder.parent
      : node;
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

function rendererRole(sourceCode: SourceCode, node: RuntimeFunction): RendererRole | null {
  const holder = holderOf(node);
  const direct = holder.parent === null ? null : propertyRole(holder.parent, holder);
  if (direct !== null) return direct;
  const binding = functionBinding(sourceCode, node);
  if (binding === null || !isImmutable(binding)) return null;
  for (const { identifier } of binding.references) {
    const role = propertyRole(identifier.parent, identifier);
    if (role !== null) return role;
  }
  return null;
}

function enclosingFunction(node: ESTree.Node): RuntimeFunction | null {
  for (let current = node.parent; current !== null; current = current.parent)
    if (isRuntimeFunction(current)) return current;
  return null;
}

function insideRenderer(sourceCode: SourceCode, node: ESTree.Node): boolean {
  for (let fn = enclosingFunction(node); fn !== null; fn = enclosingFunction(fn))
    if (rendererRole(sourceCode, fn) !== null) return true;
  return false;
}

function nullFallbackSource(node: ESTree.Expression): ESTree.Expression | null {
  return node.type === "LogicalExpression" &&
    node.operator === "??" &&
    node.right.type === "Literal" &&
    node.right.value === null
    ? node.left
    : null;
}

function exactArguments(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
  helpers = 1,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const node = unwrapExpression(expression);
  const fallbackSource = nullFallbackSource(node);
  if (fallbackSource !== null)
    return exactArguments(sourceCode, fallbackSource, depth + 1, helpers);
  if (node.type !== "Identifier") return false;
  const initializer = constValue(sourceCode, node);
  if (initializer !== null) return exactArguments(sourceCode, initializer, depth + 1, helpers);
  return exactParameter(sourceCode, node, depth, helpers);
}

function exactParameter(
  sourceCode: SourceCode,
  node: ESTree.IdentifierReference,
  depth: number,
  helpers: number,
): boolean {
  const variable = resolveVariable(sourceCode, node);
  if (variable === null || !isImmutable(variable)) return false;
  const parameter = variable.defs.find((definition) => definition.type === "Parameter");
  if (parameter === undefined || !isRuntimeFunction(parameter.node)) return false;
  const fn = parameter.node;
  const index = fn.params.findIndex(
    (param) => param.type === "Identifier" && param.name === node.name,
  );
  if (index < 0) return false;
  if (rendererRole(sourceCode, fn) === "renderCall") return index === 0;
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

function globalBinding(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
  return (resolveVariable(sourceCode, identifier)?.defs.length ?? 0) === 0;
}

function plainReplacer(sourceCode: SourceCode, replacer: ESTree.Argument | undefined): boolean {
  return (
    replacer === undefined ||
    (replacer.type === "Literal" && replacer.value === null) ||
    (replacer.type === "Identifier" &&
      replacer.name === "undefined" &&
      globalBinding(sourceCode, replacer))
  );
}

function jsonStringify(sourceCode: SourceCode, callee: ESTree.Expression): boolean {
  return (
    callee.type === "MemberExpression" &&
    staticPropertyName(callee.property, callee.computed) === "stringify" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "JSON" &&
    globalBinding(sourceCode, callee.object)
  );
}

function serializedCall(sourceCode: SourceCode, node: ESTree.CallExpression, depth = 0): boolean {
  const callee = unwrapExpression(node.callee);
  if (imported(sourceCode, callee, CORE, "invokeHostCallback")) {
    const callback = node.arguments[0];
    const fn =
      callback === undefined || callback.type === "SpreadElement"
        ? null
        : unwrapExpression(callback);
    const value = fn !== null && isRuntimeFunction(fn) ? returnedValue(fn) : null;
    return value !== null && serializedArguments(sourceCode, value, depth + 1);
  }
  const input = node.arguments[0];
  return (
    jsonStringify(sourceCode, callee) &&
    plainReplacer(sourceCode, node.arguments[1]) &&
    input !== undefined &&
    input.type !== "SpreadElement" &&
    exactArguments(sourceCode, input)
  );
}

function serializedArguments(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
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
  return node.type === "CallExpression" && serializedCall(sourceCode, node, depth);
}

function styledSink(sourceCode: SourceCode, call: ESTree.CallExpression, child: ESTree.Node): Step {
  const callee = unwrapExpression(call.callee);
  if (callee.type !== "MemberExpression") return false;
  const method = staticPropertyName(callee.property, callee.computed);
  const index = method === null ? undefined : STYLED_TEXT.get(method);
  if (index === undefined || call.arguments[index] !== child) return false;
  const color = call.arguments[0];
  if (method !== "fg" || color === undefined || !isStringLiteral(color)) return "next";
  if (color.value === "toolOutput") return true;
  return color.value === "error" && insideRenderer(sourceCode, call) ? true : "next";
}

function bindingSink(
  sourceCode: SourceCode,
  declarator: ESTree.VariableDeclarator,
  exact: boolean,
  depth: number,
): boolean {
  const variable = sourceCode.getDeclaredVariables(declarator)[0];
  return (
    declarator.id.type === "Identifier" &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const" &&
    variable !== undefined &&
    isImmutable(variable) &&
    variable.references.some(
      (reference) =>
        reference.isRead() && reachesSink(sourceCode, reference.identifier, exact, depth + 1),
    )
  );
}

function sinkStep(
  sourceCode: SourceCode,
  parent: ESTree.Node,
  child: ESTree.Node,
  exact: boolean,
  depth: number,
): Step {
  if (carriesText(parent, child)) return "next";
  if (parent.type === "CallExpression") return styledSink(sourceCode, parent, child);
  if (parent.type === "NewExpression")
    return (
      exact &&
      parent.arguments.some((argument) => argument === child) &&
      imported(sourceCode, parent.callee, "@earendil-works/pi-tui", "Text")
    );
  if (parent.type === "ReturnStatement") {
    const owner = enclosingFunction(parent);
    return exact && owner !== null && rendererRole(sourceCode, owner) === "renderCall";
  }
  if (parent.type === "ArrowFunctionExpression")
    return exact && parent.body === child && rendererRole(sourceCode, parent) === "renderCall";
  return (
    parent.type === "VariableDeclarator" &&
    parent.init === child &&
    bindingSink(sourceCode, parent, exact, depth)
  );
}

function reachesSink(
  sourceCode: SourceCode,
  node: ESTree.Node,
  exact: boolean,
  depth = 0,
): boolean {
  if (depth > MAX_DEPTH) return false;
  let child = node;
  for (let parent = node.parent; parent !== null; child = parent, parent = parent.parent) {
    const step = sinkStep(sourceCode, parent, child, exact, depth);
    if (step !== "next") return step;
  }
  return false;
}

export const noLossyExpandedArgumentsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow lossy sanitization or unescaped argument serialization in expanded tool output.",
    },
    messages: {
      lossyText:
        "{{name}} drops control characters from expanded tool output. Keep the exact text with expandedArguments(theme, args), escapeControlChars, or visible control escaping.",
      unescapedArguments:
        "Serialized renderer arguments reach the terminal unescaped; JSON.stringify keeps C1 controls. Render them with expandedArguments(theme, args) or escapeControlChars.",
    },
  },
  createOnce(context) {
    return {
      before: () => !testFile(context.filename),
      CallExpression(node) {
        const { sourceCode } = context;
        const name = destructiveSanitizer(sourceCode, node.callee);
        if (name !== null) {
          const input = node.arguments[0];
          const exact =
            input !== undefined &&
            input.type !== "SpreadElement" &&
            serializedArguments(sourceCode, input);
          if (reachesSink(sourceCode, node, exact))
            context.report({ node, messageId: "lossyText", data: { name } });
          return;
        }
        if (serializedCall(sourceCode, node) && reachesSink(sourceCode, node, true))
          context.report({ node, messageId: "unescapedArguments" });
      },
    };
  },
});
