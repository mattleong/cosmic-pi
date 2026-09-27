import * as Data from "effect/Data";
import type { DiagnosticFacts } from "./diagnostic-facts.js";

type ToolRuntimeErrorKind =
  | "UnknownTool"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "ToolCallLimitExceeded";

export class ToolRuntimeError extends Data.TaggedError("ToolRuntimeError")<{
  readonly kind: ToolRuntimeErrorKind;
  readonly message: string;
  readonly suggestions: ReadonlyArray<string>;
  readonly facts?: DiagnosticFacts;
}> {
  constructor(
    kind: ToolRuntimeErrorKind,
    message: string,
    suggestions: ReadonlyArray<string> = [],
    facts?: DiagnosticFacts,
  ) {
    super({ kind, message, suggestions, ...(facts !== undefined && { facts }) });
  }
}
