import type { InterpreterValue } from "../interpreter/model.js";
import { copyIn } from "../tool-runtime.js";

export const jsonStatics = new Set(["stringify", "parse"]);

// Native syntax/encoding and the parse-result data checkpoint. Guest callbacks,
// projection, and allocation preflight belong to interpreter/json.ts.
export const parseJsonText = (text: string): InterpreterValue =>
  copyIn(JSON.parse(text), "JSON.parse result");

export const stringifyJsonProjection = (
  value: InterpreterValue,
  propertyList: string[] | undefined,
  indent: string,
): string | undefined => JSON.stringify(value, propertyList, indent);
