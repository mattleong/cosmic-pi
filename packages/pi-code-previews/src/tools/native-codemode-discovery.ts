import {
  parse,
  type AnyNode,
  type CallExpression,
  type Expression,
  type MemberExpression,
  type NewExpression,
  type Pattern,
} from "acorn";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { isNativeMcpName } from "./native-mcp-identity";
import { ownData } from "./native-safe-content";
import { syntaxChildren } from "./native-codemode-syntax";

const MAX_SOURCE_CHARS = 32768;
const MAX_NODES = 4096;
const MAX_DEPTH = 128;
const Source = Schema.String.check(Schema.isMaxLength(MAX_SOURCE_CHARS));
const helpers = new Set(["searchTools", "describeTool", "describeNamespace"]);

export interface NativeDiscoveryIntent {
  readonly kind: "mcp" | "tools";
  readonly discoveryOnly: boolean;
}
export type NativeDiscoveryProjector = <Args>(args: Args) => NativeDiscoveryIntent | undefined;

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

const plumbingGlobals: ReadonlySet<string> = new Set(["console", "Promise"]);

function isGlobalThis(node: AnyNode): boolean {
  return node.type === "Identifier" && node.name === "globalThis";
}

function memberName(member: MemberExpression): string | undefined {
  if (member.computed) return literalText(member.property);
  return member.property.type === "Identifier" ? member.property.name : undefined;
}

function globalThisBindings(member: MemberExpression): readonly string[] {
  const name = memberName(member);
  if (name) return [name];
  return member.computed ? [...helpers] : [];
}

function memberBindings(pattern: MemberExpression): readonly string[] {
  const object = pattern.object;
  if (object.type === "Identifier" && plumbingGlobals.has(object.name)) return [object.name];
  if (object.type === "MemberExpression" && isGlobalThis(object.object)) {
    const root = memberName(object);
    if (root !== undefined && plumbingGlobals.has(root)) return [root];
  }
  return isGlobalThis(object) ? globalThisBindings(pattern) : [];
}

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
    case "MemberExpression":
      return memberBindings(pattern);
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

interface Frame {
  readonly node: AnyNode;
  readonly active: boolean;
  readonly depth: number;
}

interface Inspection {
  readonly calls: CallExpression[];
  readonly shadowed: Set<string>;
  exclusive: boolean;
}

const functionTypes: ReadonlySet<string> = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

const nonExclusiveTypes: ReadonlySet<string> = new Set([
  "NewExpression",
  "TaggedTemplateExpression",
  "ImportExpression",
  "SpreadElement",
  "ClassDeclaration",
  "ClassExpression",
]);

function parseProgram(source: string): AnyNode {
  let tokens = 0;
  return parse(source, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    preserveParens: true,
    onToken: () => {
      if (++tokens > MAX_NODES) throw new Error("Discovery source budget exceeded");
    },
  });
}

function declaredName(node: AnyNode): string | undefined {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
    case "ClassExpression":
      return node.id?.name;
    default:
      return undefined;
  }
}

function reassignedPatterns(node: AnyNode): readonly (Pattern | Expression)[] {
  switch (node.type) {
    case "VariableDeclarator":
      return [node.id];
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return node.params;
    case "CatchClause":
      return node.param ? [node.param] : [];
    case "AssignmentExpression":
      return [node.left];
    case "UpdateExpression":
      return [node.argument];
    case "UnaryExpression":
      return node.operator === "delete" ? [node.argument] : [];
    case "ForInStatement":
    case "ForOfStatement":
      return node.left.type === "VariableDeclaration" ? [] : [node.left];
    default:
      return [];
  }
}

function recordShadowing(node: AnyNode, shadowed: Set<string>): void {
  const name = declaredName(node);
  if (name) shadowed.add(name);
  for (const pattern of reassignedPatterns(node))
    for (const binding of bindings(pattern)) shadowed.add(binding);
}

function calleeNamed(node: CallExpression | NewExpression, names: readonly string[]): boolean {
  return node.callee.type === "Identifier" && names.includes(node.callee.name);
}

function forbidden(node: AnyNode): boolean {
  switch (node.type) {
    case "WithStatement":
      return true;
    case "CallExpression":
      return calleeNamed(node, ["eval", "Function"]);
    case "NewExpression":
      return calleeNamed(node, ["Function"]);
    default:
      return false;
  }
}

function breaksExclusivity(node: AnyNode): boolean {
  if (node.type === "Property") return node.computed || node.method || node.kind !== "init";
  return nonExclusiveTypes.has(node.type);
}

function visit({ node, active }: Frame, inspection: Inspection): boolean {
  recordShadowing(node, inspection.shadowed);
  if (!active) return true;
  if (forbidden(node)) return false;
  if (node.type === "CallExpression") inspection.calls.push(node);
  if (breaksExclusivity(node)) inspection.exclusive = false;
  return true;
}

function instanceInitializer(node: AnyNode, child: AnyNode): boolean {
  return node.type === "PropertyDefinition" && !node.static && child === node.value;
}

function pushChildren(stack: Frame[], { node, active, depth }: Frame): void {
  const descend = active && !functionTypes.has(node.type);
  for (const child of syntaxChildren(node))
    stack.push({
      node: child,
      active: descend && !instanceInitializer(node, child),
      depth: depth + 1,
    });
}

function inspect(program: AnyNode): Inspection | undefined {
  const inspection: Inspection = { calls: [], shadowed: new Set(), exclusive: true };
  const stack: Frame[] = [{ node: program, active: true, depth: 0 }];
  let inspected = 0;
  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    if (++inspected > MAX_NODES || frame.depth > MAX_DEPTH) return undefined;
    if (!visit(frame, inspection)) return undefined;
    pushChildren(stack, frame);
  }
  return inspection;
}

function discoveryHelper(call: CallExpression, shadowed: ReadonlySet<string>): string | undefined {
  if (
    call.callee.type !== "Identifier" ||
    !helpers.has(call.callee.name) ||
    shadowed.has(call.callee.name) ||
    call.optional ||
    call.arguments.some((arg) => arg.type === "SpreadElement")
  )
    return undefined;
  return call.callee.name;
}

function targetsMcp(call: CallExpression, helper: string): boolean {
  if (helper === "searchTools") return mcpSearch(call);
  const name = literalText(call.arguments[0]);
  if (helper === "describeNamespace") return mcpNamespace(name);
  return name !== undefined && isNativeMcpName(name);
}

function discoveryIntent(inspection: Inspection): NativeDiscoveryIntent | undefined {
  let kind: NativeDiscoveryIntent["kind"] | undefined;
  let exclusive = inspection.exclusive;
  for (const call of inspection.calls) {
    const helper = discoveryHelper(call, inspection.shadowed);
    if (helper === undefined) {
      if (!plumbing(call, inspection.shadowed)) exclusive = false;
      continue;
    }
    if (targetsMcp(call, helper)) kind = "mcp";
    else kind ??= "tools";
  }
  return kind ? { kind, discoveryOnly: exclusive } : undefined;
}

function classify(source: string): NativeDiscoveryIntent | undefined {
  const inspection = inspect(parseProgram(source));
  return inspection && discoveryIntent(inspection);
}

export function createNativeDiscoveryProjector(): NativeDiscoveryProjector {
  let previous: string | undefined;
  let intent: NativeDiscoveryIntent | undefined;
  return (args) => {
    const source = ownData(args, "code", Source);
    if (source === undefined) return undefined;
    if (source !== previous) {
      previous = source;
      intent = invokeHostCallback(() => classify(source), undefined);
    }
    return intent;
  };
}

export function nativeDiscoveryLabel(
  intent: NativeDiscoveryIntent | undefined,
): string | undefined {
  return intent ? (intent.kind === "mcp" ? "MCP discovery" : "tool discovery") : undefined;
}
