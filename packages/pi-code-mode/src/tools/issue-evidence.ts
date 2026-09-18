/** Bounded display evidence; never execution or retry authority. */
import * as Schema from "effect/Schema";
import { legacyCompactIssues, type CompactIssues } from "pi-code-previews";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { decodeOption } from "./format.ts";

const Text = Schema.String.check(Schema.isMaxLength(1024));
const Identity = Text.check(Schema.isMinLength(1));
export const BoundedIssuesSchema = Schema.Struct({
  coverage: Schema.Literals(["complete", "unknown"]),
  entries: Schema.Array(
    Schema.Struct({
      operation: Identity,
      code: Identity,
      severity: Schema.Literals(["error", "warning"]),
      cause: Text,
      recovery: Schema.Array(Schema.Struct({ code: Identity, text: Text })).check(
        Schema.isMaxLength(8),
      ),
      expandedInResult: Schema.optionalKey(Schema.Literal(true)),
    }),
  ).check(Schema.isMaxLength(32)),
});
export const freezeIssues = (issues: CompactIssues): CompactIssues =>
  Object.freeze({
    coverage: issues.coverage,
    entries: Object.freeze(
      issues.entries.map((issue) =>
        Object.freeze({
          ...issue,
          recovery: Object.freeze(issue.recovery.map((item) => Object.freeze({ ...item }))),
        }),
      ),
    ),
  });
export const invocationIssues = (issues: CompactIssues, id?: number): CompactIssues | undefined => {
  const decoded = decodeOption(BoundedIssuesSchema, issues);
  if (!decoded) return undefined;
  const clean = (text: string) =>
    sanitizeDiagnosticContent(text, { maximumLength: Number.MAX_SAFE_INTEGER });
  return decodeOption(BoundedIssuesSchema, {
    coverage: decoded.coverage,
    entries: decoded.entries.map((issue) => ({
      ...issue,
      operation: id === undefined ? clean(issue.operation) : `call-${id}/${clean(issue.operation)}`,
      code: clean(issue.code),
      cause: clean(issue.cause),
      recovery: issue.recovery.map((item) => ({ code: clean(item.code), text: clean(item.text) })),
    })),
  });
};
export { legacyCompactIssues };
