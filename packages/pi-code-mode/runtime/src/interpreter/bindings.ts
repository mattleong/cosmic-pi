import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import {
  asNode,
  type AstNode,
  getArray,
  getBoolean,
  getNode,
  getOptionalNode,
  getString,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  makeInterpreterObject,
} from "./model.js";
import {
  acquireIterator,
  iteratorStep,
  iteratorClose,
  closeOnAbrupt,
} from "./iterator-protocol.js";
import { assertBoundedCollectionSize } from "./confinement.js";
import { readProperty } from "./members.js";
import { evaluateExpression } from "./expressions.js";
import { toPropertyKey } from "./conversions.js";
import { declare, resolveBinding, variableScope } from "./scope.js";
import { type Activation } from "./activation.js";
import { isRuntimeReference } from "./references.js";

export function evaluateVariableDeclaration<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<void, RuntimeFailure, R> {
  const kind = getString(node, "kind");
  const declarations = getArray(node, "declarations");
  return Effect.gen(function* () {
    for (const declarationValue of declarations) {
      const declaration = asNode(declarationValue, "declarations");

      if (declaration.type !== "VariableDeclarator") {
        throw new InterpreterRuntimeError("Unsupported variable declaration shape.", declaration);
      }

      const init = getOptionalNode(declaration, "init");
      if (kind === "var" && !init) continue;
      const value = init ? yield* evaluateExpression(act, init) : undefined;
      yield* declarePattern(
        act,
        getNode(declaration, "id"),
        value,
        kind !== "const",
        declaration,
        kind === "var" ? "var" : undefined,
      );
    }
  });
}

export function declarePattern<R>(
  act: Activation<R>,
  pattern: AstNode,
  value: InterpreterValue,
  mutable: boolean,
  node: AstNode,
  kind?: "var",
): Effect.Effect<void, RuntimeFailure, R> {
  return destructurePattern(act, pattern, value, (target) =>
    Effect.succeed((incoming) =>
      Effect.sync(() => {
        if (target.type !== "Identifier")
          throw new InterpreterRuntimeError(
            `Unsupported binding pattern '${target.type}'.`,
            target,
          );
        const name = getString(target, "name");
        if (kind === "var") {
          const binding = resolveBinding(act, name);
          if (binding) binding.value = incoming;
          else variableScope(act).set(name, { value: incoming, mutable: true, initialized: true });
        } else declare(act, name, incoming, mutable, node);
      }),
    ),
  );
}

type PatternConsumer<R> = (value: InterpreterValue) => Effect.Effect<void, RuntimeFailure, R>;
export type PreparePatternTarget<R> = (
  target: AstNode,
) => Effect.Effect<PatternConsumer<R>, RuntimeFailure, R>;

/** Prepare leaf references before fetching their values, without declaring or reading bindings. */
function preparePattern<R>(
  host: Activation<R>,
  pattern: AstNode,
  prepare: PreparePatternTarget<R>,
): Effect.Effect<PatternConsumer<R>, RuntimeFailure, R> {
  return Effect.gen(function* () {
    if (pattern.type === "AssignmentPattern") {
      const consume = yield* preparePattern(host, getNode(pattern, "left"), prepare);
      return (value: InterpreterValue) =>
        Effect.gen(function* () {
          const resolved =
            value === undefined
              ? yield* evaluateExpression(host, getNode(pattern, "right"))
              : value;
          yield* consume(resolved);
        });
    }
    if (pattern.type === "ArrayPattern" || pattern.type === "ObjectPattern")
      return (value: InterpreterValue) => destructurePattern(host, pattern, value, prepare);
    return yield* prepare(pattern);
  });
}

/** The own enumerable data members an object rest pattern collects, minus the named ones. */
const restOf = (
  value: InterpreterValue,
  consumed: ReadonlySet<PropertyKey>,
  node: AstNode,
): InterpreterObject => {
  const rest = makeInterpreterObject();
  if (Predicate.isString(value))
    assertBoundedCollectionSize(value.length, "Destructuring rest", node);
  const source = Predicate.isString(value)
    ? Array.from(value.split(""))
    : value === null || !hasObjectRuntimeType(value) || isRuntimeReference(value)
      ? undefined
      : value;
  if (source === undefined) return rest;
  let count = 0;
  for (const key of Reflect.ownKeys(source)) {
    if (consumed.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable) continue;
    assertBoundedCollectionSize(++count, "Destructuring rest", node);
    // SAFETY: Own data members of guest arrays and objects belong to InterpreterValue.
    rest[key] = descriptor.value as InterpreterValue;
  }
  return rest;
};

/** Shared traversal only. Declaration initialization and assignment retain separate leaf operations. */
export function destructurePattern<R>(
  host: Activation<R>,
  pattern: AstNode,
  value: InterpreterValue,
  prepare: PreparePatternTarget<R>,
): Effect.Effect<void, RuntimeFailure, R> {
  return Effect.gen(function* () {
    if (pattern.type === "ObjectPattern") {
      // Properties are read like member expressions, so arrays, strings, collections and
      // namespaces destructure as in JS (`const { length } = list`, `const { max } = Math`).
      if (value === null || value === undefined)
        throw new InterpreterRuntimeError(`Cannot destructure ${String(value)}.`, pattern).as(
          "TypeError",
        );
      const consumed = new Set<PropertyKey>();
      for (const raw of getArray(pattern, "properties")) {
        const property = asNode(raw, "properties");
        if (property.type === "RestElement") {
          const consume = yield* preparePattern(host, getNode(property, "argument"), prepare);
          yield* consume(restOf(value, consumed, property));
          continue;
        }
        if (property.type !== "Property" || getString(property, "kind") !== "init")
          throw new InterpreterRuntimeError(
            "Only init object destructuring properties are supported.",
            property,
          );
        const keyNode = getNode(property, "key");
        const rawKey = getBoolean(property, "computed")
          ? toPropertyKey(yield* evaluateExpression(host, keyNode), keyNode)
          : keyNode.type === "Identifier"
            ? getString(keyNode, "name")
            : toPropertyKey(keyNode.value, keyNode);
        const key = Predicate.isSymbol(rawKey) ? rawKey : String(rawKey);
        consumed.add(key);
        const consume = yield* preparePattern(host, getNode(property, "value"), prepare);
        yield* consume(readProperty(value, key, keyNode));
      }
      return;
    }
    if (pattern.type === "ArrayPattern") {
      const iterator = yield* acquireIterator(host, value, pattern);
      for (const raw of getArray(pattern, "elements")) {
        const element = raw === null ? undefined : asNode(raw, "elements");
        const target = element?.type === "RestElement" ? getNode(element, "argument") : element;
        const consume = target
          ? yield* closeOnAbrupt(host, iterator, pattern, preparePattern(host, target, prepare))
          : undefined;
        if (element?.type === "RestElement") {
          const rest: InterpreterValue[] = [];
          while (true) {
            const step = yield* iteratorStep(host, iterator, pattern);
            if (step.done) break;
            yield* closeOnAbrupt(
              host,
              iterator,
              pattern,
              Effect.sync(() => {
                assertBoundedCollectionSize(rest.length + 1, "Destructuring rest", pattern);
                rest.push(step.value);
              }),
            );
          }
          if (consume) yield* closeOnAbrupt(host, iterator, pattern, consume(rest));
          break;
        }
        const step = yield* iteratorStep(host, iterator, pattern);
        if (consume)
          yield* closeOnAbrupt(
            host,
            iterator,
            pattern,
            consume(step.done ? undefined : step.value),
          );
      }
      yield* iteratorClose(host, iterator, pattern);
      return;
    }
    const consume = yield* preparePattern(host, pattern, prepare);
    yield* consume(value);
  });
}
