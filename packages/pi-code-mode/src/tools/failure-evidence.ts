/** Why a program failed, as bounded display evidence from the runtime's structured diagnostic. */
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { CodeModeDiagnostic, CodeModeDiagnosticFacts } from "../boundary/codemode-runtime.ts";
import { codeModeDiagnosticMessage, codeModeMessageSpan, decodeOption } from "./format.ts";
import { cleanDiagnosticText, clipText } from "./issue-evidence.ts";

const Text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const MAX_FIELD_SEGMENTS = 16;

const FailureFactsSchema = Schema.Struct({
  tool: Schema.optionalKey(Text(256)),
  toolIssue: Schema.optionalKey(
    Schema.Literals(["unknown", "namespace", "not-callable", "arity", "schema"]),
  ),
  field: Schema.optionalKey(
    Schema.Array(Schema.Union([Text(128), Schema.Number])).check(
      Schema.isMaxLength(MAX_FIELD_SEGMENTS),
    ),
  ),
  fieldIssue: Schema.optionalKey(Schema.Literals(["unexpected", "missing", "invalid"])),
  expected: Schema.optionalKey(Text(240)),
  reason: Schema.optionalKey(Text(240)),
  syntax: Schema.optionalKey(Text(64)),
  limit: Schema.optionalKey(Schema.Number),
  timeoutMs: Schema.optionalKey(Schema.Number),
  owner: Schema.optionalKey(Text(240)),
});

/**
 * Retained with failed results so presentation reads facts, never the diagnostic's wording. The
 * message itself stays in the result text, which may hold tool output; `messageSpan` only
 * points at its first line there.
 */
export const FailureEvidenceSchema = Schema.Struct({
  kind: Text(64),
  line: Schema.optionalKey(Schema.Natural),
  facts: Schema.optionalKey(FailureFactsSchema),
  messageSpan: Schema.optionalKey(Schema.Struct({ start: Schema.Natural, end: Schema.Natural })),
});
export type FailureEvidence = typeof FailureEvidenceSchema.Type;

const text = (value: string, maximum: number) => clipText(cleanDiagnosticText(value), maximum);

const boundedFacts = (facts: CodeModeDiagnosticFacts) => ({
  ...(facts.tool !== undefined && { tool: text(facts.tool, 256) }),
  ...(facts.toolIssue !== undefined && { toolIssue: facts.toolIssue }),
  ...(facts.field !== undefined && {
    field: facts.field
      .slice(0, MAX_FIELD_SEGMENTS)
      .map((segment) => (Predicate.isString(segment) ? text(segment, 128) : segment)),
  }),
  ...(facts.fieldIssue !== undefined && { fieldIssue: facts.fieldIssue }),
  ...(facts.expected !== undefined && { expected: text(facts.expected, 240) }),
  ...(facts.reason !== undefined && { reason: text(facts.reason, 240) }),
  ...(facts.syntax !== undefined && { syntax: text(facts.syntax, 64) }),
  ...(facts.limit !== undefined && { limit: facts.limit }),
  ...(facts.timeoutMs !== undefined && { timeoutMs: facts.timeoutMs }),
  ...(facts.owner !== undefined && { owner: text(facts.owner, 240) }),
});

/**
 * The runtime diagnostic as bounded evidence for the returned `text`: redacted facts, and a
 * span for the message only while the text still holds that line whole.
 */
export const failureEvidence = (
  error: CodeModeDiagnostic,
  resultText: string,
): FailureEvidence | undefined => {
  const span = codeModeMessageSpan(error);
  const line = codeModeDiagnosticMessage(error).split("\n")[0] ?? "";
  return decodeOption(FailureEvidenceSchema, {
    kind: text(error.kind, 64),
    ...(error.location !== undefined && { line: error.location.line }),
    ...(error.facts !== undefined && { facts: boundedFacts(error.facts) }),
    ...(line && resultText.slice(span.start, span.end) === line && { messageSpan: span }),
  });
};

/** The diagnostic message's first line, read from the result text at its span. */
export const failureMessage = (failure: FailureEvidence, resultText: string): string =>
  failure.messageSpan === undefined
    ? ""
    : resultText.slice(failure.messageSpan.start, failure.messageSpan.end);
