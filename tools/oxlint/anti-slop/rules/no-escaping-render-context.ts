import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constInitializer,
  importedMember,
  isRuntimeFunction,
  parameterAnnotation,
  resolveFunction,
  resolveVariable,
  staticPropertyName,
  unwrapExpression,
  type RuntimeFunction,
} from "../shared/ast.ts";

type Invocation = ESTree.CallExpression | ESTree.NewExpression;

export interface KnownHelper {
  readonly name: string;
  readonly definition: string;
  readonly specifier?: string;
  readonly retained?: readonly number[];
  readonly builders?: readonly number[];
  readonly values?: readonly number[];
}

export const knownHelpers: readonly KnownHelper[] = [
  {
    name: "composeToolComponent",
    definition: "pi-cosmic-ui/src/tool/presentation",
    specifier: "pi-cosmic-ui/tool",
    retained: [0],
  },
  {
    name: "stateHeading",
    definition: "pi-code-previews/src/tools/renderers/shared/state-heading",
    retained: [0],
  },
  {
    name: "cachedDeferredPreview",
    definition: "pi-code-previews/src/tools/renderers/shared/cache",
    retained: [6, 7],
  },
  {
    name: "cachedPreview",
    definition: "pi-code-previews/src/tools/renderers/shared/cache",
    builders: [3],
  },
  {
    name: "DeferredPreview",
    definition: "pi-code-previews/src/preview/deferred",
    retained: [2, 3],
  },
  {
    name: "deferCodePreview",
    definition: "pi-code-previews/src/application/capability",
    retained: [0],
  },
  {
    name: "unlessResultDiffShown",
    definition: "pi-code-previews/src/tools/renderers/shared/result-diff",
    retained: [1],
  },
  {
    name: "renderWithBorderSlot",
    definition: "pi-code-previews/src/preview/bordered-tool-call",
    builders: [2],
  },
  {
    name: "safeContent",
    definition: "pi-code-previews/src/tools/native-safe-content",
    builders: [0],
    values: [1],
  },
  {
    name: "invokeHostCallback",
    definition: "pi-cosmic-core/src/host-session",
    specifier: "pi-cosmic-core",
    builders: [0],
    values: [1],
  },
];

const withoutExtension = (path: string): string => path.replace(/\.[cm]?[jt]sx?$/u, "");

function nearestCallback(node: ESTree.Node): RuntimeFunction | null {
  let parent = node.parent;
  while (parent !== null && parent.type !== "Program") {
    if (isRuntimeFunction(parent)) return parent;
    parent = parent.parent;
  }
  return null;
}

function within(node: ESTree.Node, ancestor: ESTree.Node): boolean {
  for (let current: ESTree.Node | null = node; current !== null; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function modulePath(source: string, filename: string): string {
  if (!source.startsWith(".")) return source;
  const parts = filename.replaceAll("\\", "/").split("/");
  parts.pop();
  for (const part of source.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return withoutExtension(parts.join("/"));
}

function knownHelper(
  sourceCode: SourceCode,
  callee: ESTree.Expression,
  filename: string,
): KnownHelper | null {
  const imported = importedMember(sourceCode, callee);
  if (imported === null) return null;
  const module = modulePath(imported.source, filename);
  return (
    knownHelpers.find(
      (helper) =>
        helper.name === imported.name &&
        (module === helper.specifier || module.endsWith(`/packages/${helper.definition}`)),
    ) ?? null
  );
}

function declaredParameters(
  program: ESTree.Program,
  name: string,
): readonly ESTree.ParamPattern[] | null {
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration === null) continue;
    if (declaration.type === "FunctionDeclaration" && declaration.id?.name === name)
      return declaration.params;
    if (declaration.type === "ClassDeclaration" && declaration.id?.name === name) {
      for (const member of declaration.body.body) {
        if (member.type === "MethodDefinition" && member.kind === "constructor")
          return member.value.params;
      }
      return [];
    }
    if (declaration.type !== "VariableDeclaration") continue;
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier" || declarator.id.name !== name) continue;
      const init = declarator.init === null ? null : unwrapExpression(declarator.init);
      return init !== null && isRuntimeFunction(init) ? init.params : null;
    }
  }
  return null;
}

function functionTyped(type: ESTree.TSType): boolean {
  if (type.type === "TSParenthesizedType") return functionTyped(type.typeAnnotation);
  if (type.type === "TSUnionType") return type.types.some(functionTyped);
  return type.type === "TSFunctionType";
}

function argumentAt(node: Invocation, index: number): ESTree.Expression | null {
  const argument = node.arguments[index];
  return argument === undefined || argument.type === "SpreadElement" ? null : argument;
}

function parameterVariable(
  sourceCode: SourceCode,
  callback: RuntimeFunction,
  index: number,
): Variable | null {
  let parameter = callback.params[index];
  if (parameter?.type === "AssignmentPattern") parameter = parameter.left;
  if (parameter?.type !== "Identifier") return null;
  const start = parameter.start;
  return (
    sourceCode
      .getDeclaredVariables(callback)
      .find((variable) => variable.identifiers.some((identifier) => identifier.start === start)) ??
    null
  );
}

function valueOf(reference: ESTree.Node): ESTree.Node {
  let node = reference;
  while (
    node.parent !== null &&
    (node.parent.type === "ParenthesizedExpression" ||
      node.parent.type === "TSAsExpression" ||
      node.parent.type === "TSTypeAssertion" ||
      node.parent.type === "TSSatisfiesExpression" ||
      node.parent.type === "TSNonNullExpression")
  )
    node = node.parent;
  return node;
}

function contextAliases(sourceCode: SourceCode, root: Variable): Set<Variable> {
  const aliases = new Set([root]);
  for (const variable of aliases) {
    for (const reference of variable.references) {
      const parent = valueOf(reference.identifier).parent;
      if (parent?.type !== "VariableDeclarator" || parent.id.type !== "Identifier") continue;
      const alias = sourceCode.getDeclaredVariables(parent)[0];
      if (alias === undefined) continue;
      const init = constInitializer(alias);
      if (init !== null && unwrapExpression(init).start === reference.identifier.start)
        aliases.add(alias);
    }
  }
  return aliases;
}

function renderContextParameters(
  sourceCode: SourceCode,
  properties: readonly ESTree.ObjectProperty[],
): Map<RuntimeFunction, Variable> {
  const renderers = new Map<RuntimeFunction, Variable>();
  for (const property of properties) {
    const name = staticPropertyName(property.key, property.computed);
    const index = name === "renderCall" ? 2 : name === "renderResult" ? 3 : null;
    if (index === null) continue;
    const callback = resolveFunction(sourceCode, property.value);
    if (callback === null) continue;
    const variable = parameterVariable(sourceCode, callback, index);
    if (variable !== null) renderers.set(callback, variable);
  }
  return renderers;
}

function followContextIntoHelpers(
  sourceCode: SourceCode,
  renderers: Map<RuntimeFunction, Variable>,
): void {
  const pending = [...renderers.values()];
  for (let variable = pending.pop(); variable !== undefined; variable = pending.pop()) {
    for (const alias of contextAliases(sourceCode, variable)) {
      for (const reference of alias.references) {
        const argument = valueOf(reference.identifier);
        const call = argument.parent;
        if (call?.type !== "CallExpression" || call.callee === argument) continue;
        const index = call.arguments.findIndex((candidate) => candidate === argument);
        const helper = resolveFunction(sourceCode, call.callee);
        if (index < 0 || helper === null || renderers.has(helper)) continue;
        const parameter = parameterVariable(sourceCode, helper, index);
        if (parameter === null) continue;
        renderers.set(helper, parameter);
        pending.push(parameter);
      }
    }
  }
}

function retainedCallbacks(
  sourceCode: SourceCode,
  invocations: readonly Invocation[],
  filename: string,
): Set<RuntimeFunction> {
  const escaping = new Set<RuntimeFunction>();
  for (const invocation of invocations) {
    const site = knownHelper(sourceCode, invocation.callee, filename);
    for (const index of site?.retained ?? []) {
      const argument = argumentAt(invocation, index);
      const callback = argument === null ? null : resolveFunction(sourceCode, argument);
      if (callback !== null) escaping.add(callback);
    }
  }
  return escaping;
}

function componentCallbacks(
  sourceCode: SourceCode,
  value: ESTree.ObjectExpression,
): RuntimeFunction[] {
  const methods = value.properties.filter(
    (property): property is ESTree.ObjectProperty =>
      property.type === "Property" && staticPropertyName(property.key, property.computed) !== null,
  );
  if (
    !methods.some(
      (property) =>
        staticPropertyName(property.key, property.computed) === "render" &&
        resolveFunction(sourceCode, property.value) !== null,
    )
  )
    return [];
  const callbacks: RuntimeFunction[] = [];
  for (const property of methods) {
    const name = staticPropertyName(property.key, property.computed);
    if (name !== "render" && name !== "invalidate") continue;
    const callback = resolveFunction(sourceCode, property.value);
    if (callback !== null) callbacks.push(callback);
  }
  return callbacks;
}

function returnedComponentCallbacks(
  sourceCode: SourceCode,
  filename: string,
  returns: readonly ESTree.ReturnStatement[],
  renderers: Iterable<RuntimeFunction>,
  escaping: Set<RuntimeFunction>,
): void {
  const seenFunctions = new Set<RuntimeFunction>();
  const seenValues = new Set<ESTree.Expression>();
  const inspectFunction = (callback: RuntimeFunction) => {
    if (seenFunctions.has(callback)) return;
    seenFunctions.add(callback);
    if (callback.body !== null && callback.body.type !== "BlockStatement") {
      inspectValue(callback.body);
    }
    for (const statement of returns) {
      if (statement.argument !== null && nearestCallback(statement) === callback) {
        inspectValue(statement.argument);
      }
    }
  };
  const inspectCall = (call: ESTree.CallExpression) => {
    const immediate = resolveFunction(sourceCode, call.callee);
    if (immediate !== null) inspectFunction(immediate);
    const site = knownHelper(sourceCode, call.callee, filename);
    for (const index of site?.builders ?? []) {
      const argument = argumentAt(call, index);
      const callback = argument === null ? null : resolveFunction(sourceCode, argument);
      if (callback !== null) inspectFunction(callback);
    }
    for (const index of site?.values ?? []) {
      const argument = argumentAt(call, index);
      if (argument !== null) inspectValue(argument);
    }
  };
  const inspectValue = (expression: ESTree.Expression) => {
    const value = unwrapExpression(expression);
    if (seenValues.has(value)) return;
    seenValues.add(value);
    if (value.type === "Identifier") {
      const variable = resolveVariable(sourceCode, value);
      const init = variable === null ? null : constInitializer(variable);
      if (init !== null) inspectValue(init);
    } else if (value.type === "ObjectExpression") {
      for (const callback of componentCallbacks(sourceCode, value)) escaping.add(callback);
    } else if (value.type === "ConditionalExpression") {
      inspectValue(value.consequent);
      inspectValue(value.alternate);
    } else if (value.type === "LogicalExpression") {
      inspectValue(value.left);
      inspectValue(value.right);
    } else if (value.type === "CallExpression") {
      inspectCall(value);
    }
  };
  for (const renderer of renderers) inspectFunction(renderer);
}

function escapingReads(
  sourceCode: SourceCode,
  renderers: ReadonlyMap<RuntimeFunction, Variable>,
  escaping: ReadonlySet<RuntimeFunction>,
): ESTree.Node[] {
  const reads: ESTree.Node[] = [];
  const reported = new Set<RuntimeFunction>();
  for (const variable of renderers.values()) {
    for (const alias of contextAliases(sourceCode, variable)) {
      const declaration = alias.identifiers[0];
      const owner = declaration === undefined ? null : nearestCallback(declaration);
      if (owner === null || ![...escaping].some((callback) => within(callback, owner))) continue;
      for (const reference of alias.references) {
        if (!reference.isRead()) continue;
        let closure = nearestCallback(reference.identifier);
        while (closure !== null && closure !== owner && nearestCallback(closure) !== owner)
          closure = nearestCallback(closure);
        if (closure === null || closure === owner || reported.has(closure)) continue;
        reported.add(closure);
        reads.push(reference.identifier);
      }
    }
  }
  return reads;
}

export const noEscapingRenderContextRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow retaining the whole renderer context in known deferred callbacks or returned components.",
    },
    messages: {
      escapingRenderContext:
        "Do not retain the whole render context in a callback or component. Capture needed state, flags, or invalidate before constructing it; lastComponent keeps earlier components alive.",
      staleHelper:
        "no-escaping-render-context expects `{{name}}` to take callbacks at arguments [{{expected}}], but they are at [{{actual}}]. Update its helper table.",
      missingHelper:
        "no-escaping-render-context expects this module to define `{{name}}`. Update its helper table.",
    },
  },
  createOnce(context) {
    let properties: ESTree.ObjectProperty[] = [];
    let invocations: Invocation[] = [];
    let returns: ESTree.ReturnStatement[] = [];
    let program: ESTree.Program | null = null;

    const verifyDefinitions = (node: ESTree.Program) => {
      const module = withoutExtension(context.filename.replaceAll("\\", "/"));
      for (const helper of knownHelpers) {
        if (!module.endsWith(`/packages/${helper.definition}`)) continue;
        const parameters = declaredParameters(node, helper.name);
        if (parameters === null) {
          context.report({ node, messageId: "missingHelper", data: { name: helper.name } });
          continue;
        }
        const expected = [...(helper.retained ?? []), ...(helper.builders ?? [])].sort(
          (left, right) => left - right,
        );
        const actual = parameters.flatMap((parameter, index) => {
          const annotation = parameterAnnotation(parameter);
          return annotation && functionTyped(annotation.typeAnnotation) ? [index] : [];
        });
        const values = helper.values ?? [];
        if (
          expected.join() !== actual.join() ||
          values.some((index) => index >= parameters.length || actual.includes(index))
        )
          context.report({
            node,
            messageId: "staleHelper",
            data: { name: helper.name, expected: expected.join(", "), actual: actual.join(", ") },
          });
      }
    };

    return {
      Program(node) {
        properties = [];
        invocations = [];
        returns = [];
        program = node;
      },
      ObjectExpression(node) {
        for (const property of node.properties) {
          if (property.type === "Property") properties.push(property);
        }
      },
      CallExpression(node) {
        invocations.push(node);
      },
      NewExpression(node) {
        invocations.push(node);
      },
      ReturnStatement(node) {
        returns.push(node);
      },
      "Program:exit"() {
        const sourceCode = context.sourceCode;
        if (program !== null) verifyDefinitions(program);
        const renderers = renderContextParameters(sourceCode, properties);
        followContextIntoHelpers(sourceCode, renderers);
        const escaping = retainedCallbacks(sourceCode, invocations, context.filename);
        returnedComponentCallbacks(
          sourceCode,
          context.filename,
          returns,
          renderers.keys(),
          escaping,
        );
        for (const node of escapingReads(sourceCode, renderers, escaping)) {
          context.report({ node, messageId: "escapingRenderContext" });
        }
      },
    };
  },
});
