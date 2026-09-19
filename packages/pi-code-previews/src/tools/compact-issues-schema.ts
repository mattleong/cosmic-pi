import * as Schema from "effect/Schema";

/** Retained semantic evidence excludes renderer-local ownership. Overflow rejects the receipt. */
export function createBoundedCompactIssuesSchema(limits: {
  maxTextLength: number;
  maxEntries: number;
  maxRecoveryEntries: number;
  maxDiagnosticEntries: number;
}) {
  const text = Schema.String.check(Schema.isMaxLength(limits.maxTextLength));
  const identity = text.check(Schema.isMinLength(1));
  return Schema.Struct({
    coverage: Schema.Literals(["complete", "unknown"]),
    entries: Schema.Array(
      Schema.Struct({
        operation: identity,
        code: identity,
        severity: Schema.Literals(["error", "warning"]),
        cause: text,
        recovery: Schema.Array(Schema.Struct({ code: identity, text })).check(
          Schema.isMaxLength(limits.maxRecoveryEntries),
        ),
        diagnostics: Schema.optionalKey(
          Schema.Array(text).check(Schema.isMaxLength(limits.maxDiagnosticEntries)),
        ),
      }),
    ).check(Schema.isMaxLength(limits.maxEntries)),
  });
}
