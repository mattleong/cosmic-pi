/** Execution results, diagnostics, and the facts behind them. */
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/**
 * Structured facts behind a diagnostic, so hosts can present it without reading its wording.
 * Every field is optional; a diagnostic carries only the facts its kind knows.
 */
export const DiagnosticFacts = Schema.Struct({
  /** The tool path the failure concerns. */
  tool: Schema.optionalKey(Schema.String),
  toolIssue: Schema.optionalKey(
    Schema.Literals(["unknown", "namespace", "not-callable", "arity", "schema"]),
  ),
  /** The input field a schema issue points at, as path segments. */
  field: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  fieldIssue: Schema.optionalKey(Schema.Literals(["unexpected", "missing", "invalid"])),
  /** What an invalid field should have been, in the schema's words. */
  expected: Schema.optionalKey(Schema.String),
  /** The underlying reason in its source's own words, such as the parser's message. */
  reason: Schema.optionalKey(Schema.String),
  /** Unsupported syntax, by name. */
  syntax: Schema.optionalKey(Schema.String),
  /** The tool-call limit that was reached. */
  limit: Schema.optionalKey(Schema.Number),
  /** The execution timeout that expired. */
  timeoutMs: Schema.optionalKey(Schema.Number),
  /** What had to be plain data, such as the return value or a tool's arguments. */
  owner: Schema.optionalKey(Schema.String),
});
export type CodeModeDiagnosticFacts = typeof DiagnosticFacts.Type;

/** Stable categories produced by program, schema, tool, and limit failures. */
export type CodeModeDiagnosticKind =
  | "ParseError"
  | "UnknownTool"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "ToolCallLimitExceeded"
  | "TimeoutExceeded"
  | "ToolFailure"
  | "ExecutionFailure";

/** One-based source position in the program as written. */
export interface CodeModeLocation {
  readonly line: number;
  readonly column: number;
}

/** A normalized program diagnostic safe to return across the agent tool boundary. */
export interface CodeModeDiagnostic {
  /** A `CodeModeDiagnosticKind` for results this engine produces; older results may differ. */
  readonly kind: string;
  readonly message: string;
  readonly location?: CodeModeLocation;
  readonly suggestions?: ReadonlyArray<string>;
  readonly facts?: CodeModeDiagnosticFacts;
}

/** The output of a call that completed, kept for a failed program's result. */
export interface CodeModeCompletedCall {
  readonly tool: string;
  readonly text: string;
}

export interface CodeModeSuccess {
  readonly ok: true;
  readonly value: Schema.Json;
  readonly logs?: ReadonlyArray<string>;
  readonly truncated?: boolean;
}

export interface CodeModeFailure {
  readonly ok: false;
  readonly error: CodeModeDiagnostic;
  readonly logs?: ReadonlyArray<string>;
  readonly truncated?: boolean;
  /** Output of calls that completed before the program failed, oldest first. */
  readonly completed?: ReadonlyArray<CodeModeCompletedCall>;
}

/** Result of one program. Program failures are data, not Effect failures. */
export type CodeModeResult = CodeModeSuccess | CodeModeFailure;

type ToolRuntimeErrorKind =
  | "UnknownTool"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "ToolCallLimitExceeded";

/** A call refused or rejected by the dispatcher rather than by the tool itself. */
export class ToolRuntimeError extends Data.TaggedError("ToolRuntimeError")<{
  readonly kind: ToolRuntimeErrorKind;
  readonly message: string;
  readonly suggestions: ReadonlyArray<string>;
  readonly facts?: CodeModeDiagnosticFacts;
}> {
  constructor(
    kind: ToolRuntimeErrorKind,
    message: string,
    suggestions: ReadonlyArray<string> = [],
    facts?: CodeModeDiagnosticFacts,
  ) {
    super({ kind, message, suggestions, ...(facts !== undefined && { facts }) });
  }
}

/** The field and issue a schema decode failure points at, from its issue tree. */
export const schemaFailureFacts = (cause: unknown): CodeModeDiagnosticFacts => {
  if (!Schema.isSchemaError(cause)) return {};
  const field: Array<string | number> = [];
  let issue: SchemaIssue.Issue = cause.issue;
  for (;;) {
    if (issue._tag === "Pointer") {
      for (const key of issue.path) field.push(Predicate.isNumber(key) ? key : String(key));
      issue = issue.issue;
    } else if (issue._tag === "Composite") issue = issue.issues[0];
    else break;
  }
  const fieldIssue =
    issue._tag === "UnexpectedKey"
      ? "unexpected"
      : issue._tag === "MissingKey"
        ? "missing"
        : "invalid";
  // The expectation only: a type issue is rebuilt without its input so no value can leak.
  const expected =
    issue._tag === "InvalidType"
      ? new Schema.SchemaError(new SchemaIssue.InvalidType(issue.ast)).message
      : issue._tag === "Filter"
        ? new Schema.SchemaError(issue).message
        : undefined;
  return {
    ...(field.length > 0 && { field }),
    fieldIssue,
    ...(expected !== undefined && { expected }),
  };
};
