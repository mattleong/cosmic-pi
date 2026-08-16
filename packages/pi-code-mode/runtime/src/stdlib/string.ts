export const stringMethods = new Set([
  "toLowerCase",
  "toUpperCase",
  "trim",
  "trimStart",
  "trimEnd",
  "trimLeft",
  "trimRight",
  "split",
  "slice",
  "substring",
  "substr",
  "includes",
  "startsWith",
  "endsWith",
  "indexOf",
  "lastIndexOf",
  "replace",
  "replaceAll",
  "repeat",
  "padStart",
  "padEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "at",
  "concat",
  "toString",
  "match",
  "matchAll",
  "search",
  "localeCompare",
  "normalize",
]);

export const stringStatics = new Set(["fromCharCode", "fromCodePoint"]);

export const invokeStringStatic = (name: string, args: InterpreterArray, node: AstNode) => {
  const codes = args.map((arg) => {
    if (!Predicate.isNumber(arg))
      throw new InterpreterRuntimeError(`String.${name} expects number arguments.`, node);
    return arg;
  });
  switch (name) {
    case "fromCharCode":
      return String.fromCharCode(...codes);
    case "fromCodePoint":
      return String.fromCodePoint(...codes);
    default:
      throw new InterpreterRuntimeError(`String.${name} is not available in CodeMode.`, node);
  }
};
import * as Predicate from "effect/Predicate";

import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "../interpreter/model.js";
