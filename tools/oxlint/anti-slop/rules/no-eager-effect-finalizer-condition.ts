import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode, Variable } from "@oxlint/plugins";

import {
  constDeclarator,
  importedValue,
  isRuntimeFunction,
  resolveFunction,
  resolveVariable,
  staticPropertyName,
  unwrapExpression,
  type ImportedValue,
  type RuntimeFunction,
} from "../shared/ast.ts";

type Identity = "effect" | "root" | "function" | "pipe" | `effect:${string}`;

const effectCallbacks = new Set([
  "suspend",
  "tap",
  "tapError",
  "tapCause",
  "flatMap",
  "andThen",
  "catch",
  "catchCause",
]);
const valueCallbacks = new Set(["sync", "map", "mapError", "promise"]);
const constructors = new Set(["sync", "suspend", "promise", "gen"]);
const inputOperators = new Set([
  "asVoid",
  "uninterruptible",
  "interruptible",
  "scoped",
  "orDie",
  "provide",
  "timeout",
]);

function isReference(node: ESTree.Node): node is ESTree.IdentifierReference {
  return (
    node.type === "Identifier" &&
    (node.typeAnnotation === null || node.typeAnnotation === undefined)
  );
}

function memberIdentity(identity: Identity | null, name: string | null): Identity | null {
  if (name === null) return null;
  if (identity === "effect") return `effect:${name}`;
  if (identity === "root" && name === "Effect") return "effect";
  if ((identity === "root" || identity === "function") && name === "pipe") return "pipe";
  return null;
}

function importIdentity(imported: ImportedValue): Identity | null {
  const { source, name } = imported;
  if (source === "effect/Effect")
    return name === "*" ? "effect" : name === "default" ? null : `effect:${name}`;
  if (source === "effect")
    return name === "*" ? "root" : name === "Effect" ? "effect" : name === "pipe" ? "pipe" : null;
  if (source === "effect/Function")
    return name === "*" ? "function" : name === "pipe" ? "pipe" : null;
  return null;
}

function identityOf(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  seen = new Set<Variable>(),
): Identity | null {
  const node = unwrapExpression(expression);
  if (node.type === "MemberExpression") {
    return memberIdentity(
      identityOf(sourceCode, node.object, seen),
      staticPropertyName(node.property, node.computed),
    );
  }
  if (node.type !== "Identifier") return null;
  const variable = resolveVariable(sourceCode, node);
  if (variable === null || seen.has(variable) || variable.defs.length !== 1) return null;
  seen.add(variable);
  const imported = importedValue(variable);
  if (imported !== null) return importIdentity(imported);
  const declarator = constDeclarator(variable);
  if (declarator?.init === null || declarator === null) return null;
  const identity = identityOf(sourceCode, declarator.init, seen);
  if (declarator.id.type === "Identifier") return identity;
  if (declarator.id.type !== "ObjectPattern") return null;
  const property = declarator.id.properties.find(
    (candidate) =>
      candidate.type === "Property" &&
      candidate.value.type === "Identifier" &&
      candidate.value.name === variable.name,
  );
  return property?.type === "Property"
    ? memberIdentity(identity, staticPropertyName(property.key, property.computed))
    : null;
}

function methodOf(sourceCode: SourceCode, call: ESTree.CallExpression): string | null {
  const identity = identityOf(sourceCode, call.callee);
  return identity?.startsWith("effect:") ? identity.slice(7) : null;
}

type Children = ReadonlyMap<ESTree.Node, readonly ESTree.Node[]>;

function isTypeChild(parent: ESTree.Node, child: ESTree.Node): boolean {
  return (
    ("typeAnnotation" in parent && parent.typeAnnotation === child) ||
    ("typeArguments" in parent && parent.typeArguments === child) ||
    ("typeParameters" in parent && parent.typeParameters === child) ||
    ("returnType" in parent && parent.returnType === child)
  );
}

function walkEager(
  children: Children,
  node: ESTree.Node,
  visit: (node: ESTree.Node) => void,
): void {
  if (
    isRuntimeFunction(node) ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  )
    return;
  visit(node);
  for (const child of children.get(node) ?? []) {
    if (!isTypeChild(node, child)) walkEager(children, child, visit);
  }
}

interface Pipeline {
  readonly sourceCode: SourceCode;
  readonly children: Children;
  readonly callbacks: Set<RuntimeFunction>;
  readonly seen: Set<ESTree.Expression>;
}

function decisionVariables(
  sourceCode: SourceCode,
  children: Children,
  finalizer: ESTree.Expression,
): Set<Variable> {
  const variables = new Set<Variable>();
  walkEager(children, finalizer, (node) => {
    const decision =
      node.type === "ConditionalExpression"
        ? node.test
        : node.type === "LogicalExpression"
          ? node.left
          : null;
    if (decision === null) return;
    walkEager(children, decision, (reference) => {
      if (!isReference(reference)) return;
      const variable = resolveVariable(sourceCode, reference);
      if (variable?.references.some((ref) => ref.identifier === reference && ref.isRead())) {
        variables.add(variable);
      }
    });
  });
  return variables;
}

function expressionArguments(call: ESTree.CallExpression): ESTree.Expression[] | null {
  return call.arguments.some((argument) => argument.type === "SpreadElement")
    ? null
    : call.arguments.filter((argument) => argument.type !== "SpreadElement");
}

function isPipe(sourceCode: SourceCode, call: ESTree.CallExpression): boolean {
  const callee = unwrapExpression(call.callee);
  return (
    (callee.type === "MemberExpression" &&
      staticPropertyName(callee.property, callee.computed) === "pipe") ||
    identityOf(sourceCode, callee) === "pipe"
  );
}

function collectCallbacks(pipeline: Pipeline, expression: ESTree.Expression): void {
  const node = unwrapExpression(expression);
  if (pipeline.seen.has(node)) return;
  pipeline.seen.add(node);
  if (node.type === "Identifier") {
    const variable = resolveVariable(pipeline.sourceCode, node);
    const declarator = variable === null ? null : constDeclarator(variable);
    if (declarator?.id.type === "Identifier" && declarator.init !== null) {
      collectCallbacks(pipeline, declarator.init);
    }
  } else if (node.type === "ConditionalExpression") {
    collectCallbacks(pipeline, node.consequent);
    collectCallbacks(pipeline, node.alternate);
  } else if (node.type === "LogicalExpression") {
    collectCallbacks(pipeline, node.left);
    collectCallbacks(pipeline, node.right);
  } else if (node.type === "CallExpression") {
    collectCall(pipeline, node);
  }
}

function collectCall(pipeline: Pipeline, node: ESTree.CallExpression): void {
  const args = expressionArguments(node);
  if (args === null) return;
  if (isPipe(pipeline.sourceCode, node)) {
    const callee = unwrapExpression(node.callee);
    if (callee.type === "MemberExpression") collectCallbacks(pipeline, callee.object);
    for (const argument of args) collectCallbacks(pipeline, argument);
    return;
  }
  const method = methodOf(pipeline.sourceCode, node);
  if (method === null) {
    collectCurriedCall(pipeline, node, args);
  } else if (method === "ensuring") {
    for (const argument of args) collectCallbacks(pipeline, argument);
  } else if (inputOperators.has(method)) {
    if (args.length !== 0) collectCallbacks(pipeline, args[0]);
  } else {
    collectOperation(pipeline, method, args);
  }
}

function collectCurriedCall(
  pipeline: Pipeline,
  node: ESTree.CallExpression,
  args: readonly ESTree.Expression[],
): void {
  const callee = unwrapExpression(node.callee);
  if (callee.type !== "CallExpression" || args.length !== 1) return;
  const operator = methodOf(pipeline.sourceCode, callee);
  if (
    operator === null ||
    constructors.has(operator) ||
    (!effectCallbacks.has(operator) && !valueCallbacks.has(operator) && operator !== "ensuring")
  )
    return;
  collectCallbacks(pipeline, callee);
  collectCallbacks(pipeline, args[0]);
}

function collectOperation(
  pipeline: Pipeline,
  method: string,
  args: readonly ESTree.Expression[],
): void {
  if (!effectCallbacks.has(method) && !valueCallbacks.has(method) && method !== "gen") return;
  if (!constructors.has(method) && args.length === 2) collectCallbacks(pipeline, args[0]);
  const argument = constructors.has(method) ? args[0] : args.at(-1);
  if (argument === undefined) return;
  const callback = resolveFunction(pipeline.sourceCode, argument);
  if (callback === null) {
    if (effectCallbacks.has(method)) collectCallbacks(pipeline, argument);
    return;
  }
  pipeline.callbacks.add(callback);
  if ((!effectCallbacks.has(method) && method !== "gen") || callback.body === null) return;
  collectResults(pipeline, method === "gen", callback.body);
}

function collectResults(
  pipeline: Pipeline,
  generator: boolean,
  body: ESTree.FunctionBody | ESTree.Expression,
): void {
  if (body.type !== "BlockStatement") {
    collectCallbacks(pipeline, body);
    return;
  }
  walkEager(pipeline.children, body, (child) => {
    if (!generator && child.type === "ReturnStatement" && child.argument !== null)
      collectCallbacks(pipeline, child.argument);
    if (generator && child.type === "YieldExpression" && child.argument !== null)
      collectCallbacks(pipeline, child.argument);
  });
}

function wrappedInputs(
  sourceCode: SourceCode,
  ensuring: ESTree.CallExpression,
): ESTree.Expression[] {
  const args = expressionArguments(ensuring);
  if (args === null) return [];
  if (args.length === 2) return [args[0]];
  if (args.length !== 1) return [];
  let stage: ESTree.Node = ensuring;
  while (stage.parent !== null && "expression" in stage.parent && stage.parent.expression === stage)
    stage = stage.parent;
  const parent = stage.parent;
  if (parent?.type !== "CallExpression") return [];
  const inputs = expressionArguments(parent);
  if (inputs === null) return [];
  if (parent.callee === stage) return inputs.length === 1 ? inputs : [];
  if (!isPipe(sourceCode, parent)) return [];
  const index = inputs.findIndex((input) => input === stage);
  if (index === -1) return [];
  const callee = unwrapExpression(parent.callee);
  return callee.type === "MemberExpression"
    ? [callee.object, ...inputs.slice(0, index)]
    : inputs.slice(0, index);
}

function writtenInCallback(variable: Variable, callback: RuntimeFunction): boolean {
  return variable.references.some((reference) => {
    if (reference.init || !reference.isWrite()) return false;
    let ancestor: ESTree.Node | null = reference.identifier.parent;
    while (ancestor !== null) {
      if (ancestor === callback) return true;
      if (isRuntimeFunction(ancestor) || ancestor.type === "Program") return false;
      ancestor = ancestor.parent;
    }
    return false;
  });
}

export const noEagerEffectFinalizerConditionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow eager finalizer decisions that read bindings mutated by callbacks in the same wrapped Effect pipeline.",
    },
    messages: {
      eagerCondition:
        "This finalizer decision reads `{{name}}` before the wrapped Effect callback can update it. Defer the decision until finalization, for example with Effect.suspend.",
    },
  },
  createOnce(context) {
    const calls: ESTree.CallExpression[] = [];
    const children = new Map<ESTree.Node, ESTree.Node[]>();
    const check = (call: ESTree.CallExpression) => {
      const sourceCode = context.sourceCode;
      if (methodOf(sourceCode, call) !== "ensuring") return;
      const args = expressionArguments(call);
      if (args === null || (args.length !== 1 && args.length !== 2)) return;
      const finalizer = args.at(-1);
      if (finalizer === undefined) return;
      const variables = decisionVariables(sourceCode, children, finalizer);
      if (variables.size === 0) return;
      const pipeline: Pipeline = { sourceCode, children, callbacks: new Set(), seen: new Set() };
      for (const input of wrappedInputs(sourceCode, call)) collectCallbacks(pipeline, input);
      const callbacks = Array.from(pipeline.callbacks);
      const written = Array.from(variables).find(
        (variable) =>
          variable.defs.some((def) => def.type === "Variable" || def.type === "Parameter") &&
          callbacks.some((callback) => writtenInCallback(variable, callback)),
      );
      if (written !== undefined)
        context.report({
          node: finalizer,
          messageId: "eagerCondition",
          data: { name: written.name },
        });
    };
    return {
      Program() {
        calls.length = 0;
        children.clear();
      },
      "*"(node: ESTree.Node) {
        if (node.parent === null) return;
        const siblings = children.get(node.parent);
        if (siblings === undefined) children.set(node.parent, [node]);
        else siblings.push(node);
      },
      CallExpression(node) {
        calls.push(node);
      },
      "Program:exit"() {
        for (const call of calls) check(call);
      },
    };
  },
});
