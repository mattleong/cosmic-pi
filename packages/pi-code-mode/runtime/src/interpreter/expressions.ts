import { assignExpression } from "./assignment.js";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType, runtimeTypeName } from "../runtime-values.js";
import { materializeIterable } from "./iterator-protocol.js";
import { boundedData, compoundOperators } from "../stdlib/value.js";
import { coerceToString, coerceToNumber, toPrimitive } from "./conversions.js";
import { isSandboxValue, SandboxDate, SandboxPromise } from "../values.js";
import { assertBoundedCollectionSize, assertBoundedStringLength } from "./confinement.js";
import {
  asNode,
  type AstNode,
  astProperty,
  getArray,
  getBoolean,
  getNode,
  getString,
  type InterpreterArray,
  type InterpreterObject,
  InterpreterRuntimeError,
  type InterpreterValue,
  isRecord,
  makeInterpreterObject,
  OptionalShortCircuit,
  unsupportedSyntax,
  ToolReference,
  type InterpreterPrimitive,
} from "./model.js";
import { hasProperty } from "./members.js";
import { toPropertyKey } from "./conversions.js";
import { createFunction, evaluateCallExpression } from "./callable.js";
import { constructRegExp, evaluateNewExpression } from "./constructors.js";
import { settlePromise, suspendAtAwait } from "./execution.js";
import { yieldValue } from "./generators.js";
import { readMember } from "./members.js";
import { deleteMember, modifyMember } from "./member-writes.js";
import { getIdentifierValue, resolveBinding, setIdentifierValue } from "./scope.js";
import { type Activation } from "./activation.js";
import {
  containsOpaqueReference,
  instanceofValue,
  isRuntimeReference,
  typeofValue,
} from "./references.js";

export function evaluateExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  // Wall-clock confinement: normalizes deadline expiry between synchronous steps.
  act.execution.deadline.check(node);
  switch (node.type) {
    case "Literal": {
      // A regex literal parses as a Literal node carrying { pattern, flags }; construct the
      // sandbox regex from those (the host `value` instance is never exposed).
      const regex = node.regex;
      if (isRecord(regex)) {
        const pattern = astProperty(regex, "pattern");
        const flags = astProperty(regex, "flags");
        if (Predicate.isString(pattern)) {
          return Effect.sync(() =>
            constructRegExp([pattern, Predicate.isString(flags) ? flags : ""], node),
          );
        }
      }
      return Effect.sync(() => boundedData(node.value, "Literal"));
    }
    case "Identifier":
      return Effect.sync(() => getIdentifierValue(act, getString(node, "name"), node));
    case "BinaryExpression":
      return evaluateBinaryExpression(act, node);
    case "LogicalExpression":
      return evaluateLogicalExpression(act, node);
    case "UnaryExpression":
      return evaluateUnaryExpression(act, node);
    case "AssignmentExpression":
      return evaluateAssignmentExpression(act, node);
    case "CallExpression":
      return evaluateCallExpression(act, node);
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return Effect.sync(() => createFunction(act, node));
    case "MemberExpression":
      return readMember(act, node);
    case "ChainExpression":
      return Effect.map(evaluateExpression(act, getNode(node, "expression")), (value) =>
        value === OptionalShortCircuit ? undefined : value,
      );
    case "ObjectExpression":
      return evaluateObjectExpression(act, node);
    case "ArrayExpression":
      return evaluateArrayExpression(act, node);
    case "TemplateLiteral":
      return evaluateTemplateLiteral(act, node);
    case "ConditionalExpression":
      return evaluateConditionalExpression(act, node);
    case "UpdateExpression":
      return evaluateUpdateExpression(act, node);
    case "YieldExpression":
      return Effect.gen(function* () {
        const argument = node.argument;
        const value =
          argument == null
            ? undefined
            : yield* evaluateExpression(act, asNode(argument, "yield argument"));
        return yield* yieldValue(act, value, node, node.delegate === true);
      });
    case "AwaitExpression": {
      return Effect.gen(function* () {
        const value = yield* evaluateExpression(act, getNode(node, "argument"));
        // Evaluate the operand before handing control back to the caller. Every await,
        // including a plain value, ends this guest turn.
        return yield* suspendAtAwait(
          act,
          value instanceof SandboxPromise ? settlePromise(act, value, node) : Effect.succeed(value),
        );
      });
    }
    case "NewExpression":
      return evaluateNewExpression(act, node);
    case "SequenceExpression":
      return Effect.gen(function* () {
        let value: InterpreterValue;
        for (const expression of getArray(node, "expressions"))
          value = yield* evaluateExpression(act, asNode(expression, "expressions"));
        return value;
      });
    default:
      throw unsupportedSyntax(node.type, node);
  }
}

export function evaluateBinaryExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const operator = getString(node, "operator");
  return Effect.gen(function* () {
    const lhs = yield* evaluateExpression(act, getNode(node, "left"));
    const rhs = yield* evaluateExpression(act, getNode(node, "right"));
    // Like `typeof`, `instanceof` observes any value without coercing it (a promise or
    // function operand is a legitimate question, not an error), so it is handled before
    // the data-only operand check.
    if (operator === "instanceof") return instanceofValue(lhs, rhs, node);
    // `name in tools.ns` asks whether the tool tree has that name.
    if (operator === "in" && rhs instanceof ToolReference)
      return act.execution.toolKind([...rhs.path, String(toPropertyKey(lhs, node))]) !== undefined;
    return boundedData(applyBinaryOperator(operator, lhs, rhs, node), "Binary expression result");
  });
}

export function applyBinaryOperator(
  operator: string,
  lhs: InterpreterValue,
  rhs: InterpreterValue,
  node: AstNode,
): InterpreterValue {
  // Strict equality observes identity without reading or coercing opaque values.
  if (operator === "===") return lhs === rhs;
  if (operator === "!==") return lhs !== rhs;
  if (containsOpaqueReference(lhs) || containsOpaqueReference(rhs)) {
    throw new InterpreterRuntimeError(
      "Binary operators require data values in CodeMode.",
      node,
      "InvalidDataValue",
    );
  }
  switch (operator) {
    case "+": {
      const l = toPrimitive(lhs, "default");
      const r = toPrimitive(rhs, "default");
      if (!Predicate.isString(l) && !Predicate.isString(r))
        return coerceToNumber(l) + coerceToNumber(r);
      // Confinement preflight: string concatenation is the canonical doubling amplifier,
      // so the combined length is charged before the native concat allocates.
      const left = coerceToString(l);
      const right = coerceToString(r);
      assertBoundedStringLength(left.length + right.length, "String concatenation", node);
      return left + right;
    }
    // Two objects compare by identity in JS (no ToPrimitive); only object-vs-primitive coerces.
    case "==":
      return looselyEqual(lhs, rhs);
    case "!=":
      return !looselyEqual(lhs, rhs);
    case "<":
    case "<=":
    case ">":
    case ">=": {
      const l = toPrimitive(lhs, "number");
      const r = toPrimitive(rhs, "number");
      // Two strings compare by code units; anything else compares as numbers.
      return Predicate.isString(l) && Predicate.isString(r)
        ? compare(operator, l, r)
        : compare(operator, coerceToNumber(l), coerceToNumber(r));
    }
    case "in":
      return hasProperty(rhs, toPropertyKey(lhs, node), node);
    default: {
      const arithmetic = numericOperator(operator);
      if (arithmetic === undefined)
        throw new InterpreterRuntimeError(`Unsupported binary operator '${operator}'.`, node);
      return arithmetic(coerceToNumber(lhs), coerceToNumber(rhs));
    }
  }
}

/**
 * Abstract equality (`==`): two objects compare by identity; otherwise both sides convert to
 * primitives, null and undefined equal only each other, and mixed primitive types compare as
 * numbers.
 */
const looselyEqual = (lhs: InterpreterValue, rhs: InterpreterValue): boolean => {
  const lhsObject = lhs !== null && hasObjectRuntimeType(lhs);
  const rhsObject = rhs !== null && hasObjectRuntimeType(rhs);
  if (lhsObject && rhsObject) return lhs === rhs;
  const l = toPrimitive(lhs, "default");
  const r = toPrimitive(rhs, "default");
  if (l === r) return true;
  const nullish = (value: InterpreterPrimitive) => value === null || value === undefined;
  if (nullish(l) || nullish(r)) return nullish(l) && nullish(r);
  if (runtimeTypeName(l) === runtimeTypeName(r)) return false;
  if (Predicate.isSymbol(l) || Predicate.isSymbol(r)) return false;
  return Number(l) === Number(r);
};

const compare = <Operand extends string | number>(
  operator: "<" | "<=" | ">" | ">=",
  l: Operand,
  r: Operand,
): boolean => {
  switch (operator) {
    case "<":
      return l < r;
    case "<=":
      return l <= r;
    case ">":
      return l > r;
    case ">=":
      return l >= r;
  }
};

/** The numeric binary operators; each converts both operands with ToNumber first. */
const numericOperator = (operator: string): ((l: number, r: number) => number) | undefined => {
  switch (operator) {
    case "-":
      return (l, r) => l - r;
    case "*":
      return (l, r) => l * r;
    case "/":
      return (l, r) => l / r;
    case "%":
      return (l, r) => l % r;
    case "**":
      return (l, r) => l ** r;
    case "&":
      return (l, r) => l & r;
    case "|":
      return (l, r) => l | r;
    case "^":
      return (l, r) => l ^ r;
    case "<<":
      return (l, r) => l << r;
    case ">>":
      return (l, r) => l >> r;
    case ">>>":
      return (l, r) => l >>> r;
    default:
      return undefined;
  }
};

export function evaluateLogicalExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const operator = getString(node, "operator");
  return Effect.flatMap(evaluateExpression(act, getNode(node, "left")), (left) => {
    if (operator === "&&")
      return left ? evaluateExpression(act, getNode(node, "right")) : Effect.succeed(left);
    if (operator === "||")
      return left ? Effect.succeed(left) : evaluateExpression(act, getNode(node, "right"));
    if (operator === "??")
      return left !== null && left !== undefined
        ? Effect.succeed(left)
        : evaluateExpression(act, getNode(node, "right"));
    throw new InterpreterRuntimeError(`Unsupported logical operator '${operator}'.`, node);
  });
}

export function evaluateUnaryExpression<R>(act: Activation<R>, node: AstNode) {
  const operator = getString(node, "operator");
  const argument = getNode(node, "argument");
  if (operator === "void") return Effect.as(evaluateExpression(act, argument), undefined);
  if (operator === "delete") return deleteMember(act, argument, node);
  // `typeof undeclaredIdentifier` is `"undefined"` in JS (never a ReferenceError), so
  // feature-detection guards like `typeof x !== "undefined"` don't crash. Short-circuit before
  // evaluating the argument; a declared-but-TDZ binding still falls through to the normal throw.
  if (
    operator === "typeof" &&
    argument.type === "Identifier" &&
    !resolveBinding(act, getString(argument, "name"))
  ) {
    return Effect.succeed("undefined");
  }
  return Effect.map(evaluateExpression(act, argument), (value) => {
    // `typeof` and `!` never throw in JS - they observe any value (functions and runtime
    // references included) without coercing it, so feature detection and negation work.
    if (operator === "typeof")
      return value instanceof ToolReference ? toolTypeof(act, value) : typeofValue(value);
    if (operator === "!") return !value;
    if (containsOpaqueReference(value)) {
      throw new InterpreterRuntimeError(
        "Unary operators require data values in CodeMode.",
        node,
        "InvalidDataValue",
      );
    }
    // Numeric/bitwise unary operators convert with ToNumber: a Date yields its time value
    // (`+date` is the epoch-ms idiom) and data objects/arrays their string form's number.
    const operand = coerceToNumber(value);
    let result: number;
    switch (operator) {
      case "+":
        result = operand;
        break;
      case "-":
        result = -operand;
        break;
      case "~":
        result = ~operand;
        break;
      default:
        throw new InterpreterRuntimeError(`Unsupported unary operator '${operator}'.`, node);
    }
    return boundedData(result, "Unary expression result");
  });
}

export function evaluateAssignmentExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return assignExpression(act, node);
}

export function evaluateUpdateExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const operator = getString(node, "operator");
  const argument = getNode(node, "argument");
  const prefix = getBoolean(node, "prefix");

  const increment = operator === "++" ? 1 : operator === "--" ? -1 : undefined;

  if (increment === undefined) {
    throw new InterpreterRuntimeError(`Unsupported update operator '${operator}'.`, node);
  }

  if (argument.type === "Identifier") {
    return Effect.sync(() => {
      const name = getString(argument, "name");
      const current = updateOperand(getIdentifierValue(act, name, argument), node);
      const next = current + increment;
      setIdentifierValue(act, name, next, argument);
      return prefix ? next : current;
    });
  }

  if (argument.type === "MemberExpression") {
    return modifyMember(act, argument, (current) => {
      const value = updateOperand(current, node);
      const next = value + increment;
      return Effect.succeed({ write: true, next, result: prefix ? next : value });
    });
  }

  throw new InterpreterRuntimeError(
    "Update target must be an Identifier or MemberExpression.",
    argument,
  );
}

/** ToNumeric for `++`/`--`: a Date yields its time value; opaque references are refused. */
const updateOperand = (value: InterpreterValue, node: AstNode): number => {
  if (containsOpaqueReference(value) && !(value instanceof SandboxDate))
    throw new InterpreterRuntimeError(
      "Update operators require data values in CodeMode.",
      node,
      "InvalidDataValue",
    );
  return coerceToNumber(value);
};

export function evaluateObjectExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterObject, RuntimeFailure, R> {
  // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
  const objectValue: InterpreterObject = makeInterpreterObject();
  const properties = getArray(node, "properties");
  // Confinement: multiple spread sources (each individually within the entry cap) must not
  // merge into an over-cap object; distinct-key growth is counted and refused as it happens.
  let entryCount = 0;
  const countEntry = (key: PropertyKey, at: AstNode): void => {
    if (Object.hasOwn(objectValue, key)) return;
    entryCount += 1;
    assertBoundedCollectionSize(entryCount, "Object literal", at);
  };
  return Effect.gen(function* () {
    for (const propertyValue of properties) {
      const property = asNode(propertyValue, "properties");

      if (property.type === "SpreadElement") {
        const spread = yield* evaluateExpression(act, getNode(property, "argument"));
        // JS treats `{ ...null }` / `{ ...undefined }` as a no-op, so the common
        // `{ ...maybeOpts, override }` merge works when the operand is absent. Sandbox values
        // have no own enumerable properties in JS, so they are no-ops too.
        if (spread === null || spread === undefined || isSandboxValue(spread)) continue;
        if (!hasObjectRuntimeType(spread) || Array.isArray(spread) || isRuntimeReference(spread)) {
          throw new InterpreterRuntimeError(
            "Object spread requires a data object in CodeMode.",
            property,
            "InvalidDataValue",
          );
        }
        for (const key of Reflect.ownKeys(spread)) {
          const descriptor = Object.getOwnPropertyDescriptor(spread, key);
          if (!descriptor?.enumerable) continue;
          const value = descriptor.value;
          countEntry(key, property);
          objectValue[key] = value;
        }
        continue;
      }

      if (property.type !== "Property") {
        throw new InterpreterRuntimeError(
          "Only standard object properties are supported.",
          property,
        );
      }

      if (getString(property, "kind") !== "init") {
        throw new InterpreterRuntimeError("Only init object properties are supported.", property);
      }

      const keyNode = getNode(property, "key");
      const valueNode = getNode(property, "value");
      const computed = getBoolean(property, "computed");

      let key: PropertyKey;

      if (computed) {
        key = toPropertyKey(yield* evaluateExpression(act, keyNode), keyNode);
      } else if (keyNode.type === "Identifier") {
        key = getString(keyNode, "name");
      } else if (keyNode.type === "Literal") {
        key = toPropertyKey(keyNode.value, keyNode);
      } else {
        throw new InterpreterRuntimeError("Unsupported object property key shape.", keyNode);
      }

      countEntry(key, property);
      objectValue[key] = yield* evaluateExpression(act, valueNode);
    }

    return objectValue;
  });
}

export function evaluateArrayExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
  const elements = getArray(node, "elements");
  const values: InterpreterArray = [];

  return Effect.gen(function* () {
    for (const elementValue of elements) {
      if (elementValue === null) {
        assertBoundedCollectionSize(values.length + 1, "Array literal", node);
        values.length += 1;
        continue;
      }
      const element = asNode(elementValue, "elements");
      if (element.type === "SpreadElement") {
        const spread = yield* evaluateExpression(act, getNode(element, "argument"));
        const items = yield* materializeIterable(act, spread, element, "Array spread");
        assertBoundedCollectionSize(values.length + items.length, "Array spread", element);
        values.push(...items);
      } else {
        values.push(yield* evaluateExpression(act, element));
      }
    }
    return values;
  });
}

export function evaluateTemplateLiteral<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<string, RuntimeFailure, R> {
  const quasis = getArray(node, "quasis");
  const expressions = getArray(node, "expressions");

  let output = "";

  return Effect.gen(function* () {
    for (let index = 0; index < quasis.length; index += 1) {
      const quasi = asNode(quasis[index], "quasis");
      const rawValue = quasi.value;
      const cooked = isRecord(rawValue) ? astProperty(rawValue, "cooked") : undefined;

      if (!Predicate.isString(cooked)) {
        throw new InterpreterRuntimeError("Invalid template literal quasi.", quasi);
      }

      output += cooked;

      if (index < expressions.length) {
        const raw = yield* evaluateExpression(act, asNode(expressions[index], "expressions"));
        // The preserving checkpoint keeps sandbox values intact, so coerceToString renders
        // them directly (ISO date, /regex/ literal form) instead of a JSON-serialized husk.
        const rendered = coerceToString(boundedData(raw, "Template interpolation"));
        // Confinement preflight: charge the accumulated length before concatenating.
        assertBoundedStringLength(output.length + rendered.length, "Template literal", quasi);
        output += rendered;
      }
    }

    return output;
  });
}

export function evaluateConditionalExpression<R>(
  act: Activation<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.flatMap(evaluateExpression(act, getNode(node, "test")), (test) =>
    evaluateExpression(act, getNode(node, test ? "consequent" : "alternate")),
  );
}

export function applyCompoundAssignment(
  operator: string,
  current: InterpreterValue,
  incoming: InterpreterValue,
  node: AstNode,
): InterpreterValue {
  // `x op= y` is `x = x op y`: dispatch through the shared binary operator implementation
  // so compound assignment inherits the same coercion semantics (Dates, data objects, ...).
  // Only the arithmetic/bitwise operators are compoundable; logical assignments (&&=/||=/??=)
  // short-circuit and are handled by evaluateLogicalAssignment before reaching here.
  if (!compoundOperators.has(operator)) {
    throw new InterpreterRuntimeError(`Unsupported assignment operator '${operator}'.`, node);
  }
  return applyBinaryOperator(operator.slice(0, -1), current, incoming, node);
}

/** `typeof` a tool path: a tool is a function, a namespace an object, and a missing name undefined. */
const toolTypeof = <R>(act: Activation<R>, reference: ToolReference): string => {
  const kind = act.execution.toolKind(reference.path);
  return kind === "tool" ? "function" : kind === "namespace" ? "object" : "undefined";
};
