import * as Predicate from "effect/Predicate";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "../interpreter/model.js";
import { MethodTable } from "./method-table.js";
import { boundedData } from "./value.js";
import { coerceToString } from "../interpreter/conversions.js";

type NumberMethod = (
  value: number,
  optNum: (index: number) => number | undefined,
  node: AstNode,
) => string;

export const numberMethods = new MethodTable<NumberMethod>({
  toFixed: (value, optNum) => value.toFixed(optNum(0)),
  toExponential: (value, optNum) => value.toExponential(optNum(0)),
  toPrecision: (value, optNum) => {
    const digits = optNum(0);
    return digits === undefined ? value.toString() : value.toPrecision(digits);
  },
  // `toString` is named explicitly: object literals type that key from Object.prototype.
  toString: (value: number, optNum: (index: number) => number | undefined, node: AstNode) => {
    const radix = optNum(0);
    if (radix !== undefined && (radix < 2 || radix > 36)) {
      throw new InterpreterRuntimeError("Number.toString radix must be between 2 and 36.", node);
    }
    return value.toString(radix);
  },
});

export const numberConstants = new Set([
  "MAX_SAFE_INTEGER",
  "MIN_SAFE_INTEGER",
  "MAX_VALUE",
  "MIN_VALUE",
  "EPSILON",
]);

export const numberConstant = (name: string): number | undefined => {
  switch (name) {
    case "MAX_SAFE_INTEGER":
      return Number.MAX_SAFE_INTEGER;
    case "MIN_SAFE_INTEGER":
      return Number.MIN_SAFE_INTEGER;
    case "MAX_VALUE":
      return Number.MAX_VALUE;
    case "MIN_VALUE":
      return Number.MIN_VALUE;
    case "EPSILON":
      return Number.EPSILON;
    default:
      return undefined;
  }
};

export const numberStatics = new Set([
  "isInteger",
  "isFinite",
  "isNaN",
  "isSafeInteger",
  "parseInt",
  "parseFloat",
]);

export const invokeNumberMethod = (
  value: number,
  name: string,
  args: InterpreterArray,
  node: AstNode,
) => {
  const optNum = (index: number): number | undefined => {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (!Predicate.isNumber(arg))
      throw new InterpreterRuntimeError(`Number.${name} expects a number argument.`, node);
    return arg;
  };
  const method = numberMethods.get(name);
  if (method === undefined)
    throw new InterpreterRuntimeError(
      `Number method '${name}' is not available in CodeMode.`,
      node,
    );
  const result = method(value, optNum, node);
  return boundedData(result, `Number.${name} result`);
};

export const invokeNumberStatic = (name: string, args: InterpreterArray, node: AstNode) => {
  const value = args[0];
  switch (name) {
    case "isInteger":
      return Number.isInteger(value);
    case "isFinite":
      return Number.isFinite(value);
    case "isNaN":
      return Number.isNaN(value);
    case "isSafeInteger":
      return Number.isSafeInteger(value);
    case "parseInt": {
      const radix = args[1];
      if (radix !== undefined && !Predicate.isNumber(radix)) {
        throw new InterpreterRuntimeError("Number.parseInt expects a numeric radix.", node);
      }
      return parseInt(coerceToString(value), radix);
    }
    case "parseFloat":
      return parseFloat(coerceToString(value));
    default:
      throw new InterpreterRuntimeError(`Number.${name} is not available in CodeMode.`, node);
  }
};
