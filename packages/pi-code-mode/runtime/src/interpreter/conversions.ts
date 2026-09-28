import * as Predicate from "effect/Predicate";
import { hasObjectRuntimeType } from "../runtime-values.js";
import { isoString } from "../stdlib/epoch.js";
import {
  isErrorValue,
  isSandboxValue,
  SandboxDate,
  SandboxMap,
  SandboxPromise,
  SandboxRegExp,
  SandboxSet,
  SandboxURL,
  SandboxURLSearchParams,
} from "../values.js";
import { MAX_GUEST_STRING_LENGTH, uriEncodedLengthUpperBound } from "./confinement.js";
import {
  type AstNode,
  type GuestPropertyKey,
  GuestAsyncIterator,
  GuestIterator,
  InterpreterRuntimeError,
  type InterpreterPrimitive,
  type InterpreterValue,
} from "./model.js";
import { isRuntimeReference } from "./references.js";

/**
 * JavaScript's abstract conversions over guest values: ToPrimitive, ToNumber, ToString, and
 * ToPropertyKey. Operators, coercion functions, and property keys all convert through here, so
 * every guest value converts the same way wherever it is used.
 *
 * Guest objects have no prototype, so JS's own ToPrimitive would find no `valueOf`/`toString`
 * and throw. These conversions apply the results those methods have in JS instead: a Date
 * converts to its time value for numbers and its string form otherwise, and other objects and
 * arrays convert to their string form.
 */

// Confinement: array coercion joins recursively, so string production is charged against a
// shared budget - a self-referential-free but huge array (many references to one large
// string) must not materialize an unbounded native string before any checkpoint sees it.
const coerceToStringBudgeted = (value: InterpreterValue, budget: { remaining: number }): string => {
  const overflow = (): never => {
    throw new InterpreterRuntimeError(
      `String conversion would produce more than ${MAX_GUEST_STRING_LENGTH} characters in CodeMode. Convert smaller pieces and return only the data you need.`,
      undefined,
      "InvalidDataValue",
    );
  };
  const spend = (text: string): string => {
    budget.remaining -= text.length;
    if (budget.remaining < 0) overflow();
    return text;
  };
  if (value === null) return spend("null");
  if (value === undefined) return spend("undefined");
  if (value instanceof SandboxDate)
    return spend(Number.isFinite(value.time) ? isoString(value.time) : "Invalid Date");
  if (value instanceof SandboxRegExp) return spend(`/${value.regex.source}/${value.regex.flags}`);
  if (value instanceof SandboxPromise) return spend("[object Promise]");
  if (value instanceof SandboxMap) return spend("[object Map]");
  if (value instanceof SandboxSet) return spend("[object Set]");
  if (value instanceof SandboxURL) return spend(value.url.href);
  if (value instanceof SandboxURLSearchParams) {
    // Confinement preflight: the serialized worst case (percent-encoding expansion) is
    // charged entry by entry before the native serializer materializes it.
    let projected = 0;
    for (const [key, item] of value.params.entries()) {
      projected += uriEncodedLengthUpperBound(key) + uriEncodedLengthUpperBound(item) + 2;
      if (projected > budget.remaining) overflow();
    }
    return spend(value.params.toString());
  }
  if (isErrorValue(value)) {
    // Error.prototype.toString: "name: message", omitting whichever part is empty.
    const name =
      value.name === undefined ? spend("Error") : coerceToStringBudgeted(value.name, budget);
    const message =
      value.message === undefined ? "" : coerceToStringBudgeted(value.message, budget);
    if (name === "") return message;
    if (message === "") return name;
    return `${name}${spend(": ")}${message}`;
  }
  if (hasObjectRuntimeType(value)) {
    if (!Array.isArray(value)) return spend("[object Object]");
    budget.remaining -= Math.max(0, value.length - 1);
    if (budget.remaining < 0) overflow();
    const parts: Array<string> = [];
    for (const item of value) {
      parts.push(item === null || item === undefined ? "" : coerceToStringBudgeted(item, budget));
    }
    return parts.join(",");
  }
  return spend(String(value));
};

export const coerceToString = (value: InterpreterValue): string =>
  coerceToStringBudgeted(value, { remaining: MAX_GUEST_STRING_LENGTH });

/** ToPrimitive: a Date honors the hint; other objects and arrays use their string form. */
export const toPrimitive = (
  value: InterpreterValue,
  hint: "default" | "number" | "string",
): InterpreterPrimitive => {
  if (value instanceof SandboxDate) return hint === "number" ? value.time : coerceToString(value);
  return value !== null && hasObjectRuntimeType(value) ? coerceToString(value) : value;
};

/** ToNumber: numbers pass through; everything else converts through its primitive form. */
export const coerceToNumber = (value: InterpreterValue): number => {
  if (Predicate.isNumber(value)) return value;
  const primitive = toPrimitive(value, "number");
  return Predicate.isSymbol(primitive) ? Number.NaN : Number(primitive);
};

/**
 * ToPropertyKey: strings, numbers, and the iterator symbols are keys as they are; other
 * primitives and data values use their string form.
 */
export function toPropertyKey(value: InterpreterValue, node: AstNode): GuestPropertyKey {
  if (Predicate.isSymbol(value)) {
    if (value === GuestIterator) return GuestIterator;
    if (value === GuestAsyncIterator) return GuestAsyncIterator;
  }
  if (Predicate.isString(value) || Predicate.isNumber(value)) {
    return value;
  }
  // ToPropertyKey: other primitives and data values use their string form, as in JS.
  if (
    value === null ||
    value === undefined ||
    Predicate.isBoolean(value) ||
    Predicate.isBigInt(value)
  )
    return String(value);
  if (!Predicate.isSymbol(value) && (isSandboxValue(value) || !isRuntimeReference(value)))
    return coerceToString(value);

  throw new InterpreterRuntimeError(
    "Property key must be a string, number, or supported iterator symbol.",
    node,
  );
}
