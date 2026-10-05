import { parse, type AnyNode, type CallExpression, type Expression, type Pattern } from "acorn";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, invokeHostCallback } from "pi-cosmic-core";
import { isNativeMcpName } from "./native-mcp-identity";

const MAX_SOURCE_CHARS = 32768;
const MAX_NODES = 4096;
const MAX_DEPTH = 128;
const Source = Schema.String.check(Schema.isMaxLength(MAX_SOURCE_CHARS));
const helpers = new Set(["searchTools", "describeTool", "describeNamespace"]);

/** Program intent only; never a helper execution receipt, dispatch count, or remote identity. */
export interface NativeDiscoveryIntent {
  readonly kind: "mcp" | "tools";
  readonly discoveryOnly: boolean;
}
export type NativeDiscoveryProjector = <Args>(args: Args) => NativeDiscoveryIntent | undefined;

/** Expanded program annotation, including when unknown result metadata declines a summary. */
export const nativeDiscoveryNote =
  "Discovery labels reflect program source, not executed helper calls";

function literalText(node: AnyNode | undefined): string | undefined {
  return node?.type === "Literal" && Predicate.isString(node.value) ? node.value : undefined;
}

function mcpNamespace(value: string | undefined): boolean {
  return value !== undefined && /^mcp__[A-Za-z0-9_]+$/.test(value);
}

function mcpSearch(call: CallExpression): boolean {
  const options = call.arguments[1];
  if (options?.type !== "ObjectExpression") return false;
  let namespace: string | undefined;
  let seen = false;
  for (const property of options.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.method ||
      property.kind !== "init"
    )
      return false;
    const key = property.key.type === "Identifier" ? property.key.name : literalText(property.key);
    if (key !== "namespace") continue;
    if (seen) return false;
    seen = true;
    namespace = literalText(property.value);
  }
  return mcpNamespace(namespace);
}

/** Typed AST children only; comments, regex contents and template raw text are never source sites. */
function children(node: AnyNode): readonly AnyNode[] {
  switch (node.type) {
    case "Program":
    case "BlockStatement":
    case "StaticBlock":
      return node.body;
    case "ExpressionStatement":
      return [node.expression];
    case "ReturnStatement":
    case "ThrowStatement":
    case "UnaryExpression":
    case "UpdateExpression":
    case "AwaitExpression":
    case "YieldExpression":
    case "SpreadElement":
    case "RestElement":
      return node.argument ? [node.argument] : [];
    case "VariableDeclaration":
      return node.declarations;
    case "VariableDeclarator":
      return node.init ? [node.id, node.init] : [node.id];
    case "BinaryExpression":
    case "LogicalExpression":
    case "AssignmentExpression":
    case "AssignmentPattern":
      return [node.left, node.right];
    case "CallExpression":
    case "NewExpression":
      return [node.callee, ...node.arguments];
    case "MemberExpression":
      return node.computed ? [node.object, node.property] : [node.object];
    case "SequenceExpression":
      return node.expressions;
    case "ArrayExpression":
    case "ArrayPattern":
      return node.elements.filter((element) => element !== null);
    case "ObjectExpression":
    case "ObjectPattern":
      return node.properties;
    case "Property":
      return node.computed ? [node.key, node.value] : [node.value];
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return [...(node.id ? [node.id] : []), ...node.params, node.body];
    case "ClassDeclaration":
    case "ClassExpression":
      return [
        ...(node.id ? [node.id] : []),
        ...(node.superClass ? [node.superClass] : []),
        node.body,
      ];
    case "ClassBody":
      return node.body;
    case "MethodDefinition":
    case "PropertyDefinition":
      return [...(node.computed ? [node.key] : []), ...(node.value ? [node.value] : [])];
    case "ConditionalExpression":
      return [node.test, node.consequent, node.alternate];
    case "IfStatement":
      return [node.test, node.consequent, ...(node.alternate ? [node.alternate] : [])];
    case "ForStatement":
      return [
        ...(node.init ? [node.init] : []),
        ...(node.test ? [node.test] : []),
        ...(node.update ? [node.update] : []),
        node.body,
      ];
    case "ForInStatement":
    case "ForOfStatement":
      return [node.left, node.right, node.body];
    case "WhileStatement":
    case "DoWhileStatement":
      return [node.test, node.body];
    case "SwitchStatement":
      return [node.discriminant, ...node.cases];
    case "SwitchCase":
      return [...(node.test ? [node.test] : []), ...node.consequent];
    case "TryStatement":
      return [
        node.block,
        ...(node.handler ? [node.handler] : []),
        ...(node.finalizer ? [node.finalizer] : []),
      ];
    case "CatchClause":
      return [...(node.param ? [node.param] : []), node.body];
    case "LabeledStatement":
      return [node.body];
    case "TemplateLiteral":
      return node.expressions;
    case "TaggedTemplateExpression":
      return [node.tag, node.quasi];
    case "ChainExpression":
    case "ParenthesizedExpression":
      return [node.expression];
    case "ImportExpression":
      return [node.source, ...(node.options ? [node.options] : [])];
    default:
      return [];
  }
}

/** Conservative whole-program shadow/mutation veto, not an incomplete lexical scope analysis. */
function bindings(pattern: Pattern | Expression): readonly string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ArrayPattern":
      return pattern.elements.flatMap((entry) => (entry ? bindings(entry) : []));
    case "ObjectPattern":
      return pattern.properties.flatMap((entry) =>
        bindings(entry.type === "RestElement" ? entry.argument : entry.value),
      );
    case "AssignmentPattern":
      return bindings(pattern.left);
    case "RestElement":
      return bindings(pattern.argument);
    case "MemberExpression": {
      const object = pattern.object;
      if (object.type === "Identifier" && ["console", "Promise"].includes(object.name))
        return [object.name];
      if (
        object.type === "MemberExpression" &&
        object.object.type === "Identifier" &&
        object.object.name === "globalThis"
      ) {
        const root = object.computed
          ? literalText(object.property)
          : object.property.type === "Identifier"
            ? object.property.name
            : undefined;
        if (root && ["console", "Promise"].includes(root)) return [root];
      }
      if (object.type !== "Identifier" || object.name !== "globalThis") return [];
      if (!pattern.computed)
        return pattern.property.type === "Identifier" ? [pattern.property.name] : [];
      return literalText(pattern.property) ? [literalText(pattern.property)!] : [...helpers];
    }
    default:
      return [];
  }
}

function plumbing(call: CallExpression, shadowed: ReadonlySet<string>): boolean {
  if (call.callee.type === "Identifier")
    return call.callee.name === "text" && !shadowed.has("text");
  if (
    call.callee.type !== "MemberExpression" ||
    call.callee.computed ||
    call.callee.object.type !== "Identifier" ||
    call.callee.property.type !== "Identifier"
  )
    return false;
  const object = call.callee.object.name;
  const method = call.callee.property.name;
  return (
    !shadowed.has(object) &&
    ((object === "console" && ["log", "info", "warn", "error", "debug"].includes(method)) ||
      (object === "Promise" && ["all", "allSettled"].includes(method)))
  );
}

function classify(source: string): NativeDiscoveryIntent | undefined {
  let tokens = 0;
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    preserveParens: true,
    onToken: () => {
      if (++tokens > MAX_NODES) throw new Error("Discovery source budget exceeded");
    },
  });
  const stack: Array<{ node: AnyNode; active: boolean; depth: number }> = [
    { node: program, active: true, depth: 0 },
  ];
  const shadowed = new Set<string>();
  const calls: CallExpression[] = [];
  let exclusive = true;
  let inspected = 0;
  while (stack.length) {
    const frame = stack.pop()!;
    const { node, active, depth } = frame;
    if (++inspected > MAX_NODES || depth > MAX_DEPTH) return undefined;
    if (node.type === "VariableDeclarator") bindings(node.id).forEach((name) => shadowed.add(name));
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      if (node.id) shadowed.add(node.id.name);
      node.params.flatMap(bindings).forEach((name) => shadowed.add(name));
    }
    if ((node.type === "ClassDeclaration" || node.type === "ClassExpression") && node.id)
      shadowed.add(node.id.name);
    if (node.type === "CatchClause" && node.param)
      bindings(node.param).forEach((name) => shadowed.add(name));
    if (
      node.type === "AssignmentExpression" ||
      node.type === "UpdateExpression" ||
      (node.type === "UnaryExpression" && node.operator === "delete")
    )
      bindings(node.type === "AssignmentExpression" ? node.left : node.argument).forEach((name) =>
        shadowed.add(name),
      );
    if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      node.left.type !== "VariableDeclaration"
    )
      bindings(node.left).forEach((name) => shadowed.add(name));
    if (active) {
      if (node.type === "CallExpression") {
        if (node.callee.type === "Identifier" && ["eval", "Function"].includes(node.callee.name))
          return undefined;
        calls.push(node);
      }
      if (
        node.type === "WithStatement" ||
        (node.type === "NewExpression" &&
          node.callee.type === "Identifier" &&
          node.callee.name === "Function")
      )
        return undefined;
      if (node.type === "Property" && (node.computed || node.method || node.kind !== "init"))
        exclusive = false;
      if (
        [
          "NewExpression",
          "TaggedTemplateExpression",
          "ImportExpression",
          "SpreadElement",
          "ClassDeclaration",
          "ClassExpression",
        ].includes(node.type)
      )
        exclusive = false;
    }
    const descend =
      active &&
      !["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
    for (const child of children(node))
      stack.push({
        node: child,
        active:
          descend && !(node.type === "PropertyDefinition" && !node.static && child === node.value),
        depth: depth + 1,
      });
  }
  let kind: NativeDiscoveryIntent["kind"] | undefined;
  for (const call of calls) {
    if (
      call.callee.type !== "Identifier" ||
      !helpers.has(call.callee.name) ||
      shadowed.has(call.callee.name) ||
      call.optional ||
      call.arguments.some((arg) => arg.type === "SpreadElement")
    ) {
      if (!plumbing(call, shadowed)) exclusive = false;
      continue;
    }
    const target = call.arguments[0];
    const name = target?.type === "SpreadElement" ? undefined : literalText(target);
    const mcp =
      call.callee.name === "searchTools"
        ? mcpSearch(call)
        : call.callee.name === "describeNamespace"
          ? mcpNamespace(name)
          : name !== undefined && isNativeMcpName(name);
    if (mcp) kind = "mcp";
    else kind ??= "tools";
  }
  return kind ? { kind, discoveryOnly: exclusive } : undefined;
}

/** One bounded source/projection per originating renderer; no AST or process-global cache. */
export function createNativeDiscoveryProjector(): NativeDiscoveryProjector {
  let previous: string | undefined;
  let intent: NativeDiscoveryIntent | undefined;
  return (args) =>
    invokeHostCallback(() => {
      if (!Predicate.isObject(args) || Array.isArray(args)) return undefined;
      const property = Object.getOwnPropertyDescriptor(args, "code");
      if (!property || !("value" in property)) return undefined;
      const source = decodeUnknownOrUndefined(Source, property.value);
      if (source === undefined) return undefined;
      if (source !== previous) {
        previous = source;
        intent = invokeHostCallback(() => classify(source), undefined);
      }
      return intent;
    }, undefined);
}

export function nativeDiscoveryLabel(
  intent: NativeDiscoveryIntent | undefined,
): string | undefined {
  return intent ? (intent.kind === "mcp" ? "MCP discovery" : "tool discovery") : undefined;
}
