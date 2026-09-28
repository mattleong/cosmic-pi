import * as Predicate from "effect/Predicate";
import {
  type AstNode,
  type InterpreterArray,
  InterpreterRuntimeError,
} from "../interpreter/model.js";

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
