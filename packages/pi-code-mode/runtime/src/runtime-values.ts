export type RuntimeTypeName =
  | "undefined"
  | "object"
  | "boolean"
  | "number"
  | "bigint"
  | "string"
  | "symbol"
  | "function";

type RuntimeCallable = Function;

const safely = (check: () => boolean): boolean => {
  try {
    return check();
  } catch {
    return false;
  }
};

const isPrimitiveValue = <Value>(value: Value): boolean => Object(value) !== value;

export const isStringValue = <Value>(value: Value): value is Value & string =>
  isPrimitiveValue(value) && safely(() => String(value) === value);

export const isNumberValue = <Value>(value: Value): value is Value & number =>
  isPrimitiveValue(value) && safely(() => Number(value) === value || Object.is(value, Number.NaN));

export const isBooleanValue = <Value>(value: Value): value is Value & boolean =>
  value === true || value === false;

export const isSymbolValue = <Value>(value: Value): value is Value & symbol =>
  isPrimitiveValue(value) && safely(() => Symbol.prototype.valueOf.call(value) === value);

export const isBigIntValue = <Value>(value: Value): value is Value & bigint =>
  isPrimitiveValue(value) && safely(() => BigInt.prototype.valueOf.call(value) === value);

export const isFunctionValue = <Value>(value: Value): value is Value & RuntimeCallable =>
  Object(value) instanceof Function;

export const hasObjectRuntimeType = <Value>(value: Value): value is Value & (object | null) =>
  value === null || (Object(value) === value && !isFunctionValue(value));

export const runtimeTypeName = <Value>(value: Value): RuntimeTypeName => {
  if (value === undefined) return "undefined";
  if (isBooleanValue(value)) return "boolean";
  if (isNumberValue(value)) return "number";
  if (isBigIntValue(value)) return "bigint";
  if (isStringValue(value)) return "string";
  if (isSymbolValue(value)) return "symbol";
  if (isFunctionValue(value)) return "function";
  return "object";
};
