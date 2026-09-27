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
  /** The unsupported syntax node type. */
  syntax: Schema.optionalKey(Schema.String),
  /** The tool-call limit that was reached. */
  limit: Schema.optionalKey(Schema.Number),
  /** The execution timeout that expired. */
  timeoutMs: Schema.optionalKey(Schema.Number),
  /** What had to be plain data, such as the execution result or a tool's arguments. */
  owner: Schema.optionalKey(Schema.String),
});
export type DiagnosticFacts = typeof DiagnosticFacts.Type;

/** The field and issue a schema decode failure points at, from its issue tree. */
export const schemaFailureFacts = (cause: unknown): DiagnosticFacts => {
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
