/** Bounded display evidence; never execution or retry authority. */
import { createBoundedCompactIssuesSchema, type CompactIssues } from "pi-code-previews";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { decodeOption } from "./format.ts";

/** Unbounded-length diagnostic redaction; each schema applies its own length bound afterwards. */
export const cleanDiagnosticText = (text: string): string =>
  sanitizeDiagnosticContent(text, { maximumLength: Number.MAX_SAFE_INTEGER });
const clean = cleanDiagnosticText;

// Ownership belongs to a rendered card, never to a nested receipt.
export const BoundedIssuesSchema = createBoundedCompactIssuesSchema({
  maxTextLength: 1024,
  maxEntries: 32,
  maxRecoveryEntries: 8,
  maxDiagnosticEntries: 8,
});
export const invocationIssues = (issues: CompactIssues, id?: number): CompactIssues | undefined => {
  const decoded = decodeOption(BoundedIssuesSchema, issues);
  if (!decoded) return undefined;
  return decodeOption(BoundedIssuesSchema, {
    coverage: decoded.coverage,
    entries: decoded.entries.map((issue) => ({
      ...issue,
      operation: id === undefined ? clean(issue.operation) : `call-${id}/${clean(issue.operation)}`,
      code: clean(issue.code),
      cause: clean(issue.cause),
      ...(issue.description !== undefined && { description: clean(issue.description) }),
      recovery: issue.recovery.map((item) => ({ code: clean(item.code), text: clean(item.text) })),
      ...(issue.diagnostics && { diagnostics: issue.diagnostics.map(clean) }),
    })),
  });
};
