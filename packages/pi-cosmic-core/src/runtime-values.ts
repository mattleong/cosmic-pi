import * as Predicate from "effect/Predicate";

type RuntimeTypeName =
  | "undefined"
  | "object"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "symbol"
  | "function";

export const hasObjectRuntimeType = <Value>(value: Value): value is Value & (object | null) =>
  value === null || Predicate.isObjectOrArray(value);

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
