/** Bounded display evidence; never execution or retry authority. */
import { createBoundedCompactIssuesSchema, type CompactIssue } from "pi-code-previews";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";

/** Unbounded-length diagnostic redaction; each schema applies its own length bound afterwards. */
export const cleanDiagnosticText = (text: string): string =>
  sanitizeDiagnosticContent(text, { maximumLength: Number.MAX_SAFE_INTEGER });

export const MAX_RECEIPT_ISSUES = 16;
const MAX_MESSAGE = 240;
/** Matches the largest producer detail (MCP) so recovery text survives whole. */
const MAX_TEXT = 2048;

export const BoundedIssuesSchema = createBoundedCompactIssuesSchema({
  maxTextLength: MAX_TEXT,
  maxEntries: MAX_RECEIPT_ISSUES,
});

export const clipText = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/**
 * Redact and bound producer issues before they enter a retained receipt. Display text is
 * clipped rather than rejected; `dropped` reports lost evidence: issues beyond the entry
 * bound or a detail cut short.
 */
export const retainIssues = (issues: readonly CompactIssue[] | undefined) => {
  const all = issues ?? [];
  let clipped = false;
  const retained = all.slice(0, MAX_RECEIPT_ISSUES).map((issue): CompactIssue => {
    const detail = issue.detail === undefined ? undefined : cleanDiagnosticText(issue.detail);
    if (detail !== undefined && detail.length > MAX_TEXT) clipped = true;
    return {
      severity: issue.severity,
      code: clipText(cleanDiagnosticText(issue.code), MAX_TEXT) || "issue",
      message: clipText(cleanDiagnosticText(issue.message), MAX_MESSAGE),
      ...(detail && { detail: clipText(detail, MAX_TEXT) }),
    };
  });
  return { issues: retained, dropped: clipped || all.length > MAX_RECEIPT_ISSUES };
};
