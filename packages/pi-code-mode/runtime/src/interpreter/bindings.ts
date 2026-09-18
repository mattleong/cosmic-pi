import * as Effect from "effect/Effect";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { isBlockedMember } from "../tool-runtime.js";
import {
  asNode,
  type AstNode,
  type Binding,
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
export interface BindingsHost<R> extends IteratorHost<R> {
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
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  return Effect.gen({ self: this }, function* () {
    if (pattern.type === "Identifier") {
      const name = getString(pattern, "name");
      if (kind === "var") {
        const scope = this.variableScope();
        // Declaration instantiation hoists the var, but its initializer is an
        // assignment in the current environment, including a shadowing catch parameter.
        const binding = this.resolveBinding(name);
        if (binding) binding.value = value;
        else scope.set(name, { value, mutable: true, initialized: true });
      } else this.declare(name, value, mutable, node);
      return;
    }

    // Default values: `x = expr` / `{ a = 1 }` - the default is evaluated only when the value is undefined.
    if (pattern.type === "AssignmentPattern") {
      const resolved =
        value === undefined ? yield* this.evaluateExpression(getNode(pattern, "right")) : value;
      yield* this.declarePattern(getNode(pattern, "left"), resolved, mutable, node, kind);
      return;
    }

    if (pattern.type === "ObjectPattern") {
      if (
        value === null ||
        !hasObjectRuntimeType(value) ||
        Array.isArray(value) ||
        isRuntimeReference(value)
      ) {
        throw new InterpreterRuntimeError(
          "Object destructuring requires a data object value.",
          pattern,
          "InvalidDataValue",
        );
      }

      const consumed = new Set<string>();
      for (const propertyValue of getArray(pattern, "properties")) {
        const property = asNode(propertyValue, "properties");

        // Object rest: `{ a, ...others }` - gather the not-yet-consumed own keys.
        if (property.type === "RestElement") {
          // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
          const rest: InterpreterObject = makeInterpreterObject();
          for (const [key, item] of Object.entries(value as InterpreterObject)) {
            if (!consumed.has(key) && !isBlockedMember(key)) rest[key] = item;
          }
          yield* this.declarePattern(getNode(property, "argument"), rest, mutable, property, kind);
          continue;
        }

        if (
          property.type !== "Property" ||
          getBoolean(property, "computed") ||
          getString(property, "kind") !== "init"
        ) {
          throw new InterpreterRuntimeError(
            "Only named object destructuring properties are supported.",
            property,
          );
        }

        const keyNode = getNode(property, "key");
        const key =
          keyNode.type === "Identifier" ? getString(keyNode, "name") : String(keyNode.value);
        if (isBlockedMember(key)) {
          throw new InterpreterRuntimeError(
            `Property '${key}' is not available in CodeMode.`,
            keyNode,
          );
        }
        consumed.add(key);
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        yield* this.declarePattern(
          getNode(property, "value"),
          (value as InterpreterObject)[key],
          mutable,
          property,
          kind,
        );
      }
      return;
    }

    if (pattern.type === "ArrayPattern") {
      const iterator = yield* acquireIterator(this, value, pattern);
      for (const [index, item] of getArray(pattern, "elements").entries()) {
        const element = item === null ? undefined : asNode(item, `elements[${index}]`);
        if (element?.type === "RestElement") {
          const rest: Array<InterpreterValue> = [];
          while (true) {
            const step = yield* iteratorStep(this, iterator, pattern);
            if (step.done) break;
            yield* closeOnAbrupt(
              this,
              iterator,
              pattern,
              Effect.sync(() => {
                assertBoundedCollectionSize(rest.length + 1, "Destructuring rest", pattern);
                rest.push(step.value);
              }),
            );
          }
          yield* this.declarePattern(getNode(element, "argument"), rest, mutable, element, kind);
          break;
        }
        const step = yield* iteratorStep(this, iterator, pattern);
        if (element)
          yield* closeOnAbrupt(
            this,
            iterator,
            pattern,
            this.declarePattern(element, step.value, mutable, pattern, kind),
          );
      }
      yield* iteratorClose(this, iterator, pattern);
      return;
    }

    throw new InterpreterRuntimeError(`Unsupported binding pattern '${pattern.type}'.`, pattern);
  });
}
