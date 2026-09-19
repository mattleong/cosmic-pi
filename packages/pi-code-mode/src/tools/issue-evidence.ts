/** Bounded display evidence; never execution or retry authority. */
import {
  createBoundedCompactIssuesSchema,
  legacyCompactIssues,
  type CompactIssues,
} from "pi-code-previews";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { decodeOption } from "./format.ts";

// Ownership belongs to a rendered card, never to a nested receipt.
export const BoundedIssuesSchema = createBoundedCompactIssuesSchema({
  maxTextLength: 1024,
  maxEntries: 32,
  maxRecoveryEntries: 8,
  maxDiagnosticEntries: 8,
});
export const freezeIssues = (issues: CompactIssues): CompactIssues =>
  Object.freeze({
    coverage: issues.coverage,
    entries: Object.freeze(
      issues.entries.map((issue) =>
        Object.freeze({
          ...issue,
          recovery: Object.freeze(issue.recovery.map((item) => Object.freeze({ ...item }))),
          ...(issue.diagnostics && { diagnostics: Object.freeze([...issue.diagnostics]) }),
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
      ...(issue.diagnostics && { diagnostics: issue.diagnostics.map(clean) }),
    })),
  });
};
export { legacyCompactIssues };
