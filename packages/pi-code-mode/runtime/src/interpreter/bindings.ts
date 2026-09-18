import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { isBlockedMember } from "../tool-runtime.js";
import {
  asNode,
  type AstNode,
  type Binding,
  type GuestPropertyKey,
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
import { isRuntimeReference } from "./runtime.js";
import {
  acquireIterator,
  iteratorStep,
  iteratorClose,
  closeOnAbrupt,
  type IteratorHost,
} from "./iterator-protocol.js";
import { assertBoundedCollectionSize } from "./confinement.js";
export interface PatternHost<R> extends IteratorHost<R> {
  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  toPropertyKey(value: InterpreterValue, node: AstNode): GuestPropertyKey;
}

export interface BindingsHost<R> extends PatternHost<R> {
  variableScope(): Map<string, Binding>;
  resolveBinding(name: string): Binding | undefined;
  declare(name: string, value: InterpreterValue, mutable: boolean, node: AstNode): void;
  declarePattern(
    pattern: AstNode,
    value: InterpreterValue,
    mutable: boolean,
    node: AstNode,
    kind?: "var",
  ): Effect.Effect<void, RuntimeFailure, R>;
  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
}

export function evaluateVariableDeclaration<R>(
  this: BindingsHost<R>,
  node: AstNode,
): Effect.Effect<void, RuntimeFailure, R> {
  const kind = getString(node, "kind");
  const declarations = getArray(node, "declarations");
  return Effect.gen({ self: this }, function* () {
    for (const declarationValue of declarations) {
      const declaration = asNode(declarationValue, "declarations");

      if (declaration.type !== "VariableDeclarator") {
        throw new InterpreterRuntimeError("Unsupported variable declaration shape.", declaration);
      }

      const init = getOptionalNode(declaration, "init");
      if (kind === "var" && !init) continue;
      const value = init ? yield* this.evaluateExpression(init) : undefined;
      yield* this.declarePattern(
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
  this: BindingsHost<R>,
  pattern: AstNode,
  value: InterpreterValue,
  mutable: boolean,
  node: AstNode,
  kind?: "var",
): Effect.Effect<void, RuntimeFailure, R> {
  return destructurePattern(this, pattern, value, (target) =>
    Effect.succeed((incoming) =>
      Effect.sync(() => {
        if (target.type !== "Identifier")
          throw new InterpreterRuntimeError(
            `Unsupported binding pattern '${target.type}'.`,
            target,
          );
        const name = getString(target, "name");
        if (kind === "var") {
          const binding = this.resolveBinding(name);
          if (binding) binding.value = incoming;
          else
            this.variableScope().set(name, { value: incoming, mutable: true, initialized: true });
        } else this.declare(name, incoming, mutable, node);
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
  host: PatternHost<R>,
  pattern: AstNode,
  prepare: PreparePatternTarget<R>,
): Effect.Effect<PatternConsumer<R>, RuntimeFailure, R> {
  return Effect.gen(function* () {
    if (pattern.type === "AssignmentPattern") {
      const consume = yield* preparePattern(host, getNode(pattern, "left"), prepare);
      return (value: InterpreterValue) =>
        Effect.gen(function* () {
          const resolved =
            value === undefined ? yield* host.evaluateExpression(getNode(pattern, "right")) : value;
          yield* consume(resolved);
        });
    }
    if (pattern.type === "ArrayPattern" || pattern.type === "ObjectPattern")
      return (value: InterpreterValue) => destructurePattern(host, pattern, value, prepare);
    return yield* prepare(pattern);
  });
}

/** Shared traversal only. Declaration initialization and assignment retain separate leaf operations. */
export function destructurePattern<R>(
  host: PatternHost<R>,
  pattern: AstNode,
  value: InterpreterValue,
  prepare: PreparePatternTarget<R>,
): Effect.Effect<void, RuntimeFailure, R> {
  return Effect.gen(function* () {
    if (pattern.type === "ObjectPattern") {
      if (
        value === null ||
        !hasObjectRuntimeType(value) ||
        Array.isArray(value) ||
        isRuntimeReference(value)
      )
        throw new InterpreterRuntimeError(
          "Object destructuring requires a data object value.",
          pattern,
          "InvalidDataValue",
        );
      // SAFETY: Only confined data objects pass the preceding checks.
      const object = value as InterpreterObject;
      const consumed = new Set<PropertyKey>();
      for (const raw of getArray(pattern, "properties")) {
        const property = asNode(raw, "properties");
        if (property.type === "RestElement") {
          const consume = yield* preparePattern(host, getNode(property, "argument"), prepare);
          const rest = makeInterpreterObject();
          let count = 0;
          for (const key of Reflect.ownKeys(object)) {
            if (consumed.has(key) || (Predicate.isString(key) && isBlockedMember(key))) continue;
            const descriptor = Object.getOwnPropertyDescriptor(object, key);
            if (!descriptor?.enumerable) continue;
            assertBoundedCollectionSize(++count, "Destructuring rest", property);
            rest[key] = descriptor.value;
          }
          yield* consume(rest);
          continue;
        }
        if (property.type !== "Property" || getString(property, "kind") !== "init")
          throw new InterpreterRuntimeError(
            "Only init object destructuring properties are supported.",
            property,
          );
        const keyNode = getNode(property, "key");
        const rawKey = getBoolean(property, "computed")
          ? host.toPropertyKey(yield* host.evaluateExpression(keyNode), keyNode)
          : keyNode.type === "Identifier"
            ? getString(keyNode, "name")
            : host.toPropertyKey(keyNode.value, keyNode);
        const key = Predicate.isSymbol(rawKey) ? rawKey : String(rawKey);
        if (Predicate.isString(key) && isBlockedMember(key))
          throw new InterpreterRuntimeError(
            `Property '${key}' is not available in CodeMode.`,
            keyNode,
          );
        consumed.add(key);
        const consume = yield* preparePattern(host, getNode(property, "value"), prepare);
        yield* consume(Object.hasOwn(object, key) ? object[key] : undefined);
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
