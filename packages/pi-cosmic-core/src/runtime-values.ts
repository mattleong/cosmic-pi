import * as Predicate from "effect/Predicate";

export type RuntimeTypeName =
  | "undefined"
  | "object"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "symbol"
  | "function";

/** Matches JavaScript's `typeof value === "object"`, including `null` and excluding functions. */
export const hasObjectRuntimeType = <Value>(value: Value): value is Value & (object | null) =>
  value === null || Predicate.isObjectOrArray(value);

/** A non-throwing replacement for JavaScript's runtime `typeof` operator. */
export const runtimeTypeName = <Value>(value: Value): RuntimeTypeName => {
  if (Predicate.isUndefined(value)) return "undefined";
  if (Predicate.isBoolean(value)) return "boolean";
  if (Predicate.isNumber(value)) return "number";
  if (Predicate.isBigInt(value)) return "bigint";
  if (Predicate.isString(value)) return "string";
  if (Predicate.isSymbol(value)) return "symbol";
  if (Predicate.isFunction(value)) return "function";
  return "object";
};
