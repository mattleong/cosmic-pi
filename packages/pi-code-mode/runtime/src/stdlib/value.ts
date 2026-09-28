import * as Predicate from "effect/Predicate";
import {
  type AstNode,
  type InterpreterArray,
  CoercionFunction,
  InterpreterRuntimeError,
  type InterpreterValue,
} from "../interpreter/model.js";
import { isSandboxValue, SandboxPromise } from "../values.js";
import { copyIn } from "../tool-runtime-data.js";
import { coerceToNumber, coerceToString } from "../interpreter/conversions.js";

export const errorConstructors = new Set([
  "Error",
  "AggregateError",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
]);

export const compoundOperators = new Set([
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "&=",
  "|=",
  "^=",
  "<<=",
  ">>=",
  ">>>=",
]);

export const boundedData = (value: InterpreterValue, label: string): InterpreterValue =>
  copyIn(value, label, true);

export const invokeCoercion = (ref: CoercionFunction, args: InterpreterArray, node: AstNode) => {
  const raw = args[0];
  if (ref.name === "isNaN") return Number.isNaN(coerceToNumber(raw));
  if (ref.name === "isFinite") return Number.isFinite(coerceToNumber(raw));
  if (isSandboxValue(raw) || raw instanceof SandboxPromise) {
    if (ref.name === "Boolean") return true;
    if (ref.name === "Number") return coerceToNumber(raw);
    if (ref.name === "String") return coerceToString(raw);
    if (ref.name === "parseInt") return parseInt(coerceToString(raw));
    return parseFloat(coerceToString(raw));
  }
  const value = boundedData(args[0], `${ref.name} input`);
  if (ref.name === "Number") return coerceToNumber(value);
  if (ref.name === "Boolean") return Boolean(value);
  if (ref.name === "parseInt") {
    const radix = args[1];
    if (radix !== undefined && !Predicate.isNumber(radix)) {
      throw new InterpreterRuntimeError("parseInt expects a numeric radix.", node);
    }
    return parseInt(coerceToString(value), radix);
  }
  if (ref.name === "parseFloat") return parseFloat(coerceToString(value));
  return coerceToString(value);
};
