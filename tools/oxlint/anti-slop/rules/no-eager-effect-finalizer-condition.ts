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
  return node.type === "Identifier" && node.typeAnnotation == null;
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

/** Only actual imports and immutable aliases identify Effect, never spelling alone. */
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
    (property) =>
      property.type === "Property" &&
      property.value.type === "Identifier" &&
      property.value.name === variable.name,
  );
  return property?.type === "Property"
    ? memberIdentity(identity, staticPropertyName(property.key, property.computed))
    : null;
}

function methodOf(sourceCode: SourceCode, call: ESTree.CallExpression): string | null {
  const identity = identityOf(sourceCode, call.callee);
  return identity?.startsWith("effect:") ? identity.slice(7) : null;
}

function walkEager(
  sourceCode: SourceCode,
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
  // SAFETY: Oxlint visitor keys identify only AST child nodes, arrays of child nodes, or null.
  const children = node as ESTree.Node &
    Readonly<Record<string, ESTree.Node | ESTree.Node[] | null | undefined>>;
  for (const key of sourceCode.visitorKeys[node.type] ?? []) {
    // Type-only identifiers cannot participate in a runtime branch decision.
    if (
      key === "typeAnnotation" ||
      key === "typeArguments" ||
      key === "typeParameters" ||
      key === "returnType"
    )
      continue;
    const child = children[key];
    if (Array.isArray(child)) {
      for (const element of child) if (element !== null) walkEager(sourceCode, element, visit);
    } else if (child !== null && child !== undefined) walkEager(sourceCode, child, visit);
  }
}

/** Read only branch decisions, not values mentioned in the selected finalizer. */
function decisionVariables(sourceCode: SourceCode, finalizer: ESTree.Expression): Set<Variable> {
  const variables = new Set<Variable>();
  walkEager(sourceCode, finalizer, (node) => {
    const decision =
      node.type === "ConditionalExpression"
        ? node.test
        : node.type === "LogicalExpression"
          ? node.left
          : null;
    if (decision === null) return;
    walkEager(sourceCode, decision, (reference) => {
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

/** Follow explicit effect inputs and effect-returning callbacks, not arbitrary nearby calls. */
function collectCallbacks(
  sourceCode: SourceCode,
  expression: ESTree.Expression,
  callbacks: Set<RuntimeFunction>,
  seen: Set<ESTree.Expression>,
): void {
  const node = unwrapExpression(expression);
  if (seen.has(node)) return;
  seen.add(node);
  const collect = (input: ESTree.Expression) =>
    collectCallbacks(sourceCode, input, callbacks, seen);
  if (node.type === "Identifier") {
    const variable = resolveVariable(sourceCode, node);
    const declarator = variable === null ? null : constDeclarator(variable);
    if (declarator?.init !== null && declarator !== null && declarator.id.type === "Identifier") {
      collect(declarator.init);
    }
    return;
  }
  if (node.type === "ConditionalExpression") {
    collect(node.consequent);
    collect(node.alternate);
    return;
  }
  if (node.type === "LogicalExpression") {
    collect(node.left);
    collect(node.right);
    return;
  }
  if (node.type !== "CallExpression") return;
  const args = expressionArguments(node);
  if (args === null) return;
  if (isPipe(sourceCode, node)) {
    const callee = unwrapExpression(node.callee);
    if (callee.type === "MemberExpression") collect(callee.object);
    for (const argument of args) collect(argument);
    return;
  }
  const method = methodOf(sourceCode, node);
  if (method === null) {
    const callee = unwrapExpression(node.callee);
    if (callee.type !== "CallExpression" || args.length !== 1) return;
    const operator = methodOf(sourceCode, callee);
    if (
      operator === null ||
      constructors.has(operator) ||
      (!effectCallbacks.has(operator) && !valueCallbacks.has(operator) && operator !== "ensuring")
    )
      return;
    collect(callee);
    collect(args[0]);
    return;
  }
  if (method === "ensuring") {
    for (const argument of args) collect(argument);
    return;
  }
  if (inputOperators.has(method)) {
    if (args.length !== 0) collect(args[0]);
    return;
  }
  if (!effectCallbacks.has(method) && !valueCallbacks.has(method) && method !== "gen") return;
  if (!constructors.has(method) && args.length === 2) collect(args[0]);
  const argument = constructors.has(method) ? args[0] : args.at(-1);
  if (argument === undefined) return;
  const callback = resolveFunction(sourceCode, argument);
  if (callback === null) {
    if (effectCallbacks.has(method)) collect(argument);
    return;
  }
  callbacks.add(callback);
  if ((!effectCallbacks.has(method) && method !== "gen") || callback.body === null) return;
  if (callback.body.type !== "BlockStatement") {
    collect(callback.body);
    return;
  }
  walkEager(sourceCode, callback.body, (child) => {
    if (method !== "gen" && child.type === "ReturnStatement" && child.argument !== null)
      collect(child.argument);
    if (method === "gen" && child.type === "YieldExpression" && child.argument !== null)
      collect(child.argument);
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

/** A construction-time decision cannot observe a later mutation by its wrapped effect. */
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
    return {
      Program() {
        calls.length = 0;
      },
      CallExpression(node) {
        calls.push(node);
      },
      "Program:exit"() {
        for (const call of calls) {
          if (methodOf(context.sourceCode, call) !== "ensuring") continue;
          const args = expressionArguments(call);
          if (args === null || (args.length !== 1 && args.length !== 2)) continue;
          const finalizer = args.at(-1);
          if (finalizer === undefined) continue;
          const variables = decisionVariables(context.sourceCode, finalizer);
          if (variables.size === 0) continue;
          const callbacks = new Set<RuntimeFunction>();
          const seen = new Set<ESTree.Expression>();
          for (const input of wrappedInputs(context.sourceCode, call)) {
            collectCallbacks(context.sourceCode, input, callbacks, seen);
          }
          for (const variable of variables) {
            if (!variable.defs.some((def) => def.type === "Variable" || def.type === "Parameter"))
              continue;
            if (!Array.from(callbacks).some((callback) => writtenInCallback(variable, callback)))
              continue;
            context.report({
              node: finalizer,
              messageId: "eagerCondition",
              data: { name: variable.name },
            });
            break;
          }
        }
      },
    };
  },
});
