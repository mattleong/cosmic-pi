import * as Data from "effect/Data";

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
}> {
  constructor(
    kind: ToolRuntimeErrorKind,
    message: string,
    suggestions: ReadonlyArray<string> = [],
  ) {
    super({ kind, message, suggestions });
  }
}
