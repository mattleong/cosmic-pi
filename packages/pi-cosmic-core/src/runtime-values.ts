import * as Match from "effect/Match";
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

export const runtimeTypeName = Match.type<unknown>().pipe(
  Match.when(Predicate.isUndefined, (): RuntimeTypeName => "undefined"),
  Match.when(Predicate.isBoolean, (): RuntimeTypeName => "boolean"),
  Match.when(Predicate.isNumber, (): RuntimeTypeName => "number"),
  Match.when(Predicate.isBigInt, (): RuntimeTypeName => "bigint"),
  Match.when(Predicate.isString, (): RuntimeTypeName => "string"),
  Match.when(Predicate.isSymbol, (): RuntimeTypeName => "symbol"),
  Match.when(Predicate.isFunction, (): RuntimeTypeName => "function"),
  Match.orElse((): RuntimeTypeName => "object"),
);
