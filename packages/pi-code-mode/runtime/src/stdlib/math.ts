export const mathConstants = new Set([
  "PI",
  "E",
  "LN2",
  "LN10",
  "LOG2E",
  "LOG10E",
  "SQRT2",
  "SQRT1_2",
]);

export const mathConstant = (name: string): number | undefined => {
  switch (name) {
    case "PI":
      return Math.PI;
    case "E":
      return Math.E;
    case "LN2":
      return Math.LN2;
    case "LN10":
      return Math.LN10;
    case "LOG2E":
      return Math.LOG2E;
    case "LOG10E":
      return Math.LOG10E;
    case "SQRT2":
      return Math.SQRT2;
    case "SQRT1_2":
      return Math.SQRT1_2;
    default:
      return undefined;
  }
};

export const mathMethods = new Set([
  "max",
  "min",
  "abs",
  "floor",
  "ceil",
  "round",
  "trunc",
  "sign",
  "sqrt",
  "cbrt",
  "pow",
  "hypot",
  "log",
  "log2",
  "log10",
  "exp",
]);

export const invokeMathMethod = (name: string, args: InterpreterArray, node: AstNode): number => {
  if (!mathMethods.has(name))
    throw new InterpreterRuntimeError(`Math.${name} is not available in CodeMode.`, node);
  // Fixed-arity functions ignore callback index/container arguments just as native Math does.
  // Keep numeric validation for consumed arguments, including every variadic argument.
  const consumed =
    name === "max" || name === "min" || name === "hypot"
      ? args
      : args.slice(0, name === "pow" ? 2 : 1);
  const nums = consumed.map((arg) => {
    if (!Predicate.isNumber(arg))
      throw new InterpreterRuntimeError(`Math.${name} expects number arguments.`, node);
    return arg;
  });
  const [a = Number.NaN, b = Number.NaN] = nums;
  switch (name) {
    case "max":
      return Math.max(...nums);
    case "min":
      return Math.min(...nums);
    case "abs":
      return Math.abs(a);
    case "floor":
      return Math.floor(a);
    case "ceil":
      return Math.ceil(a);
    case "round":
      return Math.round(a);
    case "trunc":
      return Math.trunc(a);
    case "sign":
      return Math.sign(a);
    case "sqrt":
      return Math.sqrt(a);
    case "cbrt":
      return Math.cbrt(a);
    case "pow":
      return Math.pow(a, b);
    case "hypot":
      return Math.hypot(...nums);
    case "log":
      return Math.log(a);
    case "log2":
      return Math.log2(a);
    case "log10":
      return Math.log10(a);
    case "exp":
      return Math.exp(a);
  }
  throw new InterpreterRuntimeError(`Math.${name} is not available in CodeMode.`, node);
};
import * as Predicate from "effect/Predicate";

import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "../interpreter/model.js";
