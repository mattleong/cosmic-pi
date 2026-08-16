export const numberMethods = new Set(["toFixed", "toPrecision", "toExponential", "toString"]);

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
    if (!isNumberValue(arg))
      throw new InterpreterRuntimeError(`Number.${name} expects a number argument.`, node);
    return arg;
  };
  let result: string;
  switch (name) {
    case "toFixed":
      result = value.toFixed(optNum(0));
      break;
    case "toExponential":
      result = value.toExponential(optNum(0));
      break;
    case "toPrecision": {
      const digits = optNum(0);
      result = digits === undefined ? value.toString() : value.toPrecision(digits);
      break;
    }
    case "toString": {
      const radix = optNum(0);
      if (radix !== undefined && (radix < 2 || radix > 36)) {
        throw new InterpreterRuntimeError("Number.toString radix must be between 2 and 36.", node);
      }
      result = value.toString(radix);
      break;
    }
    default:
      throw new InterpreterRuntimeError(
        `Number method '${name}' is not available in CodeMode.`,
        node,
      );
  }
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
      if (radix !== undefined && !isNumberValue(radix)) {
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
import { isNumberValue } from "../runtime-values.ts";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "../interpreter/model.js";
import { boundedData, coerceToString } from "./value.js";
