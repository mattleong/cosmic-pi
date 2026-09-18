import { assignExpression, type AssignmentHost } from "./assignment.js";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as Scope from "effect/Scope";
import type { RuntimeFailure } from "../failure.js";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { materializeIterable, type IteratorHost } from "./iterator-protocol.js";
import { boundedData, coerceToString, compoundOperators } from "../stdlib/value.js";
import { isBlockedMember } from "../tool-runtime.js";
import { isSandboxValue, SandboxDate, SandboxPromise, SandboxRegExp } from "../values.js";
import {
  assertBoundedCollectionSize,
  assertBoundedStringLength,
  ExecutionDeadline,
} from "./confinement.js";
import { GuestTurns } from "./guest-turns.js";
import {
  asNode,
  type AstNode,
  type GuestPropertyKey,
  astProperty,
  type Binding,
  CodeModeFunction,
  getArray,
  getBoolean,
  getNode,
  getString,
  type InterpreterArray,
  type InterpreterObject,
  type InterpreterPrimitive,
  InterpreterRuntimeError,
  type InterpreterValue,
  isRecord,
  makeInterpreterObject,
  OptionalShortCircuit,
  unsupportedSyntax,
} from "./model.js";
import {
  containsOpaqueReference,
  instanceofValue,
  isRuntimeReference,
  typeofValue,
} from "./runtime.js";
export interface ExpressionsHost<R> extends IteratorHost<R>, AssignmentHost<R> {
  callDepth: number;
  yieldValue(
    value: InterpreterValue,
    node: AstNode,
    delegate: boolean,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  applyBinaryOperator(
    operator: string,
    lhs: InterpreterValue,
    rhs: InterpreterValue,
    node: AstNode,
  ): InterpreterValue;
  applyCompoundAssignment(
    operator: string,
    current: InterpreterValue,
    incoming: InterpreterValue,
    node: AstNode,
  ): InterpreterValue;
  constructRegExp(args: InterpreterArray, node: AstNode): SandboxRegExp;
  createFunction(node: AstNode): CodeModeFunction;
  deadline: ExecutionDeadline;
  evaluateArrayExpression(node: AstNode): Effect.Effect<InterpreterArray, RuntimeFailure, R>;
  evaluateAssignmentExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateBinaryExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateCallExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateConditionalExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateLogicalAssignment(
    node: AstNode,
    left: AstNode,
    operator: string,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateLogicalExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateNewExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateObjectExpression(node: AstNode): Effect.Effect<InterpreterObject, RuntimeFailure, R>;
  evaluateTemplateLiteral(node: AstNode): Effect.Effect<string, RuntimeFailure, R>;
  evaluateUnaryExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  evaluateUpdateExpression(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  execution: {
    nextToolCallLifecycleId: number;
    activePromises: number;
    scope: Scope.Scope;
    turns: GuestTurns;
    interrupting: Set<SandboxPromise>;
  };
  firstBoundary: Deferred.Deferred<void> | undefined;
  getIdentifierValue(name: string, node: AstNode): InterpreterValue;
  modifyMember(
    node: AstNode,
    compute: (
      current: InterpreterValue,
    ) => Effect.Effect<
      { write: boolean; next: InterpreterValue; result: InterpreterValue },
      RuntimeFailure,
      R
    >,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  readMember(node: AstNode): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
  releaseTurn(): Effect.Effect<void>;
  resolveBinding(name: string): Binding | undefined;
  setIdentifierValue(name: string, value: InterpreterValue, node: AstNode): InterpreterValue;
  settlePromise(
    promise: SandboxPromise,
    node?: AstNode,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, never>;
  toPropertyKey(value: InterpreterValue, node: AstNode): GuestPropertyKey;
  turn: { held: boolean };
  writeMember(
    node: AstNode,
    value: InterpreterValue,
  ): Effect.Effect<InterpreterValue, RuntimeFailure, R>;
}

export function evaluateExpression<R>(
  this: ExpressionsHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  // Wall-clock confinement: normalizes deadline expiry between synchronous steps.
  this.deadline.check(node);
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
            this.constructRegExp([pattern, Predicate.isString(flags) ? flags : ""], node),
          );
        }
      }
      return Effect.sync(() => boundedData(node.value, "Literal"));
    }
    case "Identifier":
      return Effect.sync(() => this.getIdentifierValue(getString(node, "name"), node));
    case "BinaryExpression":
      return this.evaluateBinaryExpression(node);
    case "LogicalExpression":
      return this.evaluateLogicalExpression(node);
    case "UnaryExpression":
      return this.evaluateUnaryExpression(node);
    case "AssignmentExpression":
      return this.evaluateAssignmentExpression(node);
    case "CallExpression":
      return this.evaluateCallExpression(node);
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return Effect.sync(() => this.createFunction(node));
    case "MemberExpression":
      return this.readMember(node);
    case "ChainExpression":
      return Effect.map(this.evaluateExpression(getNode(node, "expression")), (value) =>
        value === OptionalShortCircuit ? undefined : value,
      );
    case "ObjectExpression":
      return this.evaluateObjectExpression(node);
    case "ArrayExpression":
      return this.evaluateArrayExpression(node);
    case "TemplateLiteral":
      return this.evaluateTemplateLiteral(node);
    case "ConditionalExpression":
      return this.evaluateConditionalExpression(node);
    case "UpdateExpression":
      return this.evaluateUpdateExpression(node);
    case "YieldExpression":
      return Effect.gen({ self: this }, function* () {
        const argument = node.argument;
        const value =
          argument == null
            ? undefined
            : yield* this.evaluateExpression(asNode(argument, "yield argument"));
        return yield* this.yieldValue(value, node, node.delegate === true);
      });
    case "AwaitExpression": {
      return Effect.gen({ self: this }, function* () {
        const value = yield* this.evaluateExpression(getNode(node, "argument"));
        // Evaluate the operand before handing control back to the caller. Every await,
        // including a plain value, ends this guest turn.
        yield* this.releaseTurn();
        if (this.firstBoundary !== undefined) {
          const boundary = this.firstBoundary;
          this.firstBoundary = undefined;
          yield* Deferred.succeed(boundary, undefined);
        }
        const settled =
          value instanceof SandboxPromise
            ? yield* Effect.exit(this.settlePromise(value, node))
            : Exit.succeed(value);
        yield* this.execution.turns.take(this.turn);
        this.callDepth = 0;
        return yield* settled;
      });
    }
    case "NewExpression":
      return this.evaluateNewExpression(node);
    default:
      throw unsupportedSyntax(node.type, node);
  }
}

export function evaluateBinaryExpression<R>(
  this: ExpressionsHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const operator = getString(node, "operator");
  return Effect.gen({ self: this }, function* () {
    const lhs = yield* this.evaluateExpression(getNode(node, "left"));
    const rhs = yield* this.evaluateExpression(getNode(node, "right"));
    // Like `typeof`, `instanceof` observes any value without coercing it (a promise or
    // function operand is a legitimate question, not an error), so it is handled before
    // the data-only operand check.
    if (operator === "instanceof") return instanceofValue(lhs, rhs, node);
    return boundedData(
      this.applyBinaryOperator(operator, lhs, rhs, node),
      "Binary expression result",
    );
  });
}

export function applyBinaryOperator<R>(
  this: ExpressionsHost<R>,
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
  // Data objects/arrays are null-prototype, so JS's ToPrimitive throws an opaque host
  // "No default value" TypeError when an operator coerces them. Coerce to their JS string
  // form first (as String(x) / template literals do) so operators behave like JavaScript.
  // A Date follows its ToPrimitive hints: string for `+` (concatenation), its time value
  // for arithmetic and ordering - so `end - start` and `a < b` work as in JS.
  // Identity (=== / !==) and the right operand of `in` keep their raw object value.
  const coerceOperand = (operand: InterpreterValue): InterpreterPrimitive => {
    if (operand instanceof SandboxDate)
      return operator === "+" ? coerceToString(operand) : operand.time;
    return operand !== null && hasObjectRuntimeType(operand) ? coerceToString(operand) : operand;
  };
  const bothObjects =
    lhs !== null && hasObjectRuntimeType(lhs) && rhs !== null && hasObjectRuntimeType(rhs);
  const l = coerceOperand(lhs);
  const r = coerceOperand(rhs);
  switch (operator) {
    case "+":
      // Confinement preflight: string concatenation is the canonical doubling amplifier,
      // so the combined length is charged before the native concat allocates.
      if (Predicate.isString(l) || Predicate.isString(r)) {
        assertBoundedStringLength(
          (Predicate.isString(l) ? l.length : 32) + (Predicate.isString(r) ? r.length : 32),
          "String concatenation",
          node,
        );
      }
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as string) + (r as string);
    case "-":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) - (r as number);
    case "*":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) * (r as number);
    case "/":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) / (r as number);
    case "%":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) % (r as number);
    case "**":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) ** (r as number);
    // Two objects compare by identity in JS (no ToPrimitive); only object-vs-primitive coerces.
    case "==":
      return bothObjects ? lhs === rhs : l == r;
    case "===":
      return lhs === rhs;
    case "!=":
      return bothObjects ? lhs !== rhs : l != r;
    case "!==":
      return lhs !== rhs;
    case "<":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as string) < (r as string);
    case "<=":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as string) <= (r as string);
    case ">":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as string) > (r as string);
    case ">=":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as string) >= (r as string);
    case "&":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) & (r as number);
    case "|":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) | (r as number);
    case "^":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) ^ (r as number);
    case "<<":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) << (r as number);
    case ">>":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) >> (r as number);
    case ">>>":
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return (l as number) >>> (r as number);
    case "in":
      if (rhs === null || !hasObjectRuntimeType(rhs)) {
        throw new InterpreterRuntimeError(
          "The 'in' operator requires a data object on the right-hand side.",
          node,
        );
      }
      // Own properties only, so arrays don't leak the host Array.prototype (map/constructor/...).
      // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
      return Object.hasOwn(rhs as object, coerceOperand(lhs) as PropertyKey);
    default:
      throw new InterpreterRuntimeError(`Unsupported binary operator '${operator}'.`, node);
  }
}

export function evaluateLogicalExpression<R>(
  this: ExpressionsHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const operator = getString(node, "operator");
  return Effect.flatMap(this.evaluateExpression(getNode(node, "left")), (left) => {
    if (operator === "&&")
      return left ? this.evaluateExpression(getNode(node, "right")) : Effect.succeed(left);
    if (operator === "||")
      return left ? Effect.succeed(left) : this.evaluateExpression(getNode(node, "right"));
    if (operator === "??")
      return left !== null && left !== undefined
        ? Effect.succeed(left)
        : this.evaluateExpression(getNode(node, "right"));
    throw new InterpreterRuntimeError(`Unsupported logical operator '${operator}'.`, node);
  });
}

export function evaluateUnaryExpression<R>(this: ExpressionsHost<R>, node: AstNode) {
  const operator = getString(node, "operator");
  const argument = getNode(node, "argument");
  // `typeof undeclaredIdentifier` is `"undefined"` in JS (never a ReferenceError), so
  // feature-detection guards like `typeof x !== "undefined"` don't crash. Short-circuit before
  // evaluating the argument; a declared-but-TDZ binding still falls through to the normal throw.
  if (
    operator === "typeof" &&
    argument.type === "Identifier" &&
    !this.resolveBinding(getString(argument, "name"))
  ) {
    return Effect.succeed("undefined");
  }
  return Effect.map(this.evaluateExpression(argument), (value) => {
    // `typeof` and `!` never throw in JS - they observe any value (functions and runtime
    // references included) without coercing it, so feature detection and negation work.
    if (operator === "typeof") return typeofValue(value);
    if (operator === "!") return !value;
    if (containsOpaqueReference(value)) {
      throw new InterpreterRuntimeError(
        "Unary operators require data values in CodeMode.",
        node,
        "InvalidDataValue",
      );
    }
    // Numeric/bitwise unary operators ToPrimitive their operand; a Date yields its time value
    // (`+date` is the epoch-ms idiom), other null-prototype data objects/arrays coerce to
    // their JS string form first (see evaluateBinaryExpression).
    const operand =
      value instanceof SandboxDate
        ? value.time
        : value !== null && hasObjectRuntimeType(value)
          ? coerceToString(value)
          : value;
    let result: number;
    switch (operator) {
      case "+":
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        result = +(operand as number);
        break;
      case "-":
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        result = -(operand as number);
        break;
      case "~":
        // SAFETY: The interpreter's preceding variant checks establish the narrowed runtime representation used here.
        result = ~(operand as number);
        break;
      default:
        throw new InterpreterRuntimeError(`Unsupported unary operator '${operator}'.`, node);
    }
    return boundedData(result, "Unary expression result");
  });
}

export function evaluateAssignmentExpression<R>(
  this: ExpressionsHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return assignExpression(this, node);
}

export function evaluateLogicalAssignment<R>(
  this: ExpressionsHost<R>,
  node: AstNode,
  left: AstNode,
  operator: string,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  const shouldAssign = (current: InterpreterValue): boolean =>
    operator === "??="
      ? current === null || current === undefined
      : operator === "||="
        ? !current
        : Boolean(current);
  if (left.type === "Identifier") {
    const name = getString(left, "name");
    return Effect.gen({ self: this }, function* () {
      const current = this.getIdentifierValue(name, left);
      if (!shouldAssign(current)) return current;
      const rightValue = yield* this.evaluateExpression(getNode(node, "right"));
      return this.setIdentifierValue(name, rightValue, left);
    });
  }
  if (left.type === "MemberExpression") {
    // Resolve the member exactly once; evaluate the RHS only if we actually assign.
    return this.modifyMember(left, (current) =>
      shouldAssign(current)
        ? Effect.map(this.evaluateExpression(getNode(node, "right")), (rightValue) => ({
            write: true,
            next: rightValue,
            result: rightValue,
          }))
        : Effect.succeed({ write: false, next: current, result: current }),
    );
  }
  throw new InterpreterRuntimeError(
    "Assignment target must be an Identifier or MemberExpression.",
    left,
  );
}

export function evaluateUpdateExpression<R>(
  this: ExpressionsHost<R>,
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
      const current = Number(this.getIdentifierValue(name, argument));
      const next = current + increment;
      this.setIdentifierValue(name, next, argument);
      return prefix ? next : current;
    });
  }

  if (argument.type === "MemberExpression") {
    return this.modifyMember(argument, (current) => {
      const value = Number(current);
      const next = value + increment;
      return Effect.succeed({ write: true, next, result: prefix ? next : value });
    });
  }

  throw new InterpreterRuntimeError(
    "Update target must be an Identifier or MemberExpression.",
    argument,
  );
}

export function evaluateObjectExpression<R>(
  this: ExpressionsHost<R>,
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
  return Effect.gen({ self: this }, function* () {
    for (const propertyValue of properties) {
      const property = asNode(propertyValue, "properties");

      if (property.type === "SpreadElement") {
        const spread = yield* this.evaluateExpression(getNode(property, "argument"));
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
          if (Predicate.isString(key) && isBlockedMember(key))
            throw new InterpreterRuntimeError(
              `Property '${key}' is not available in CodeMode.`,
              property,
            );
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
        key = this.toPropertyKey(yield* this.evaluateExpression(keyNode), keyNode);
      } else if (keyNode.type === "Identifier") {
        key = getString(keyNode, "name");
      } else if (keyNode.type === "Literal") {
        key = this.toPropertyKey(keyNode.value, keyNode);
      } else {
        throw new InterpreterRuntimeError("Unsupported object property key shape.", keyNode);
      }

      if (isBlockedMember(String(key))) {
        throw new InterpreterRuntimeError(
          `Property '${String(key)}' is not available in CodeMode.`,
          keyNode,
        );
      }
      countEntry(key, property);
      objectValue[key] = yield* this.evaluateExpression(valueNode);
    }

    return objectValue;
  });
}

export function evaluateArrayExpression<R>(
  this: ExpressionsHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterArray, RuntimeFailure, R> {
  const elements = getArray(node, "elements");
  const values: InterpreterArray = [];

  return Effect.gen({ self: this }, function* () {
    for (const elementValue of elements) {
      if (elementValue === null) {
        assertBoundedCollectionSize(values.length + 1, "Array literal", node);
        values.length += 1;
        continue;
      }
      const element = asNode(elementValue, "elements");
      if (element.type === "SpreadElement") {
        const spread = yield* this.evaluateExpression(getNode(element, "argument"));
        const items = yield* materializeIterable(this, spread, element, "Array spread");
        assertBoundedCollectionSize(values.length + items.length, "Array spread", element);
        values.push(...items);
      } else {
        values.push(yield* this.evaluateExpression(element));
      }
    }
    return values;
  });
}

export function evaluateTemplateLiteral<R>(
  this: ExpressionsHost<R>,
  node: AstNode,
): Effect.Effect<string, RuntimeFailure, R> {
  const quasis = getArray(node, "quasis");
  const expressions = getArray(node, "expressions");

  let output = "";

  return Effect.gen({ self: this }, function* () {
    for (let index = 0; index < quasis.length; index += 1) {
      const quasi = asNode(quasis[index], "quasis");
      const rawValue = quasi.value;
      const cooked = isRecord(rawValue) ? astProperty(rawValue, "cooked") : undefined;

      if (!Predicate.isString(cooked)) {
        throw new InterpreterRuntimeError("Invalid template literal quasi.", quasi);
      }

      output += cooked;

      if (index < expressions.length) {
        const raw = yield* this.evaluateExpression(asNode(expressions[index], "expressions"));
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
  this: ExpressionsHost<R>,
  node: AstNode,
): Effect.Effect<InterpreterValue, RuntimeFailure, R> {
  return Effect.flatMap(this.evaluateExpression(getNode(node, "test")), (test) =>
    this.evaluateExpression(getNode(node, test ? "consequent" : "alternate")),
  );
}

export function applyCompoundAssignment<R>(
  this: ExpressionsHost<R>,
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
  return this.applyBinaryOperator(operator.slice(0, -1), current, incoming, node);
}
