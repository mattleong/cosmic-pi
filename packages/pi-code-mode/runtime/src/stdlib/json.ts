import { isNumberValue, isStringValue } from "../runtime-values.ts";
import { assertBoundedJsonEstimate } from "../interpreter/confinement.js";
import {
  type AstNode,
  type InterpreterArray,
  CodeModeFunction,
  InterpreterRuntimeError,
  supportedSyntaxMessage,
} from "../interpreter/model.js";
import { copyIn, copyOut } from "../tool-runtime.js";

export const jsonStatics = new Set(["stringify", "parse"]);

export const invokeJsonMethod = (name: string, args: InterpreterArray, node: AstNode) => {
  if (!jsonStatics.has(name))
    throw new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node);
  switch (name) {
    case "stringify": {
      const replacer = args[1];
      if (Array.isArray(replacer) || replacer instanceof CodeModeFunction) {
        throw new InterpreterRuntimeError(
          "JSON.stringify replacers are not supported in CodeMode.",
          node,
          "UnsupportedSyntax",
          [supportedSyntaxMessage],
        );
      }
      const space = args[2];
      const indent = isNumberValue(space) || isStringValue(space) ? space : undefined;
      const data = copyOut(copyIn(args[0], "JSON.stringify value"));
      // Confinement preflight: refuse before the native serializer materializes an
      // over-limit string. Indented output multiplies size by up to depth x indent width,
      // so a pretty-print request runs against a proportionally smaller estimate budget.
      assertBoundedJsonEstimate(data, node, indent === undefined ? 1 : 8);
      return JSON.stringify(data, null, indent);
    }
    case "parse": {
      const text = args[0];
      if (!isStringValue(text))
        throw new InterpreterRuntimeError("JSON.parse expects a string.", node);
      try {
        return copyIn(JSON.parse(text), "JSON.parse result");
      } catch (error) {
        throw new InterpreterRuntimeError(
          `JSON.parse received invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          node,
        ).as("SyntaxError");
      }
    }
  }
  throw new InterpreterRuntimeError(`JSON.${name} is not available in CodeMode.`, node);
};
