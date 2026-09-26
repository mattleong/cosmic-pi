import * as Predicate from "effect/Predicate";
import { getObjectValue } from "../shared/helpers";
import { escapeControlChars } from "../shared/terminal-text";
import { getBashWarnings } from "../warnings/bash";
import { getWriteDiffGuard, getWriteDiffSkipReason, hasWriteDiffSizeEvidence } from "../write/diff";
import type { BuiltinCompactPolicy } from "./builtin-projection";
import type { CompactIssue } from "./compact-issues";
import { isTruncated, splitReadContinuationNotice } from "./data/results";
import { getPreviewSecretWarnings } from "./renderers/shared/secret-preview";

const VOWEL_SOUND = new Set(["AWS secret key", "API key"]);
const withArticle = (label: string) => `${VOWEL_SOUND.has(label) ? "an" : "a"} ${label}`;

export function secretIssues(
  sources: readonly string[],
  enabled: boolean,
  limit: number,
): CompactIssue[] {
  const warnings = new Set(
    sources.flatMap((source) => getPreviewSecretWarnings(source, enabled, limit)),
  );
  return warnings.size > 0
    ? [
        {
          severity: "warning",
          code: "possible-secrets",
          message: `May contain ${[...warnings].map(withArticle).join(", ")}`,
        },
      ]
    : [];
}

export function bashCommandIssues(command: string, enabled: boolean): CompactIssue[] {
  if (!enabled) return [];
  // Do not partially scan a command and imply its unscanned middle is safe.
  if (command.length > 16 * 1024)
    return [
      {
        severity: "warning",
        code: "command-unchecked",
        message: "Too long to check for risky operations",
      },
    ];
  return getBashWarnings(command).map((label, index) => ({
    severity: "warning",
    code: `command-risk-${index}`,
    message: label,
  }));
}

export function readIssues<Details>(
  details: Details,
  output: string,
  hasLimit: boolean,
): CompactIssue[] | undefined {
  const truncation = getObjectValue(details, "truncation");
  if (getObjectValue(truncation, "firstLineExceedsLimit") === true) {
    // This successful read contains only the host's bash recovery instruction.
    return output
      ? [
          {
            severity: "warning",
            code: "oversized-first-line",
            message: "The first line is too large to display",
            detail: escapeControlChars(output),
          },
        ]
      : undefined;
  }
  const truncated = isTruncated(details);
  if (!truncated && !hasLimit) return [];
  const { notice } = splitReadContinuationNotice(output);
  if (notice) {
    const lastLinePartial = getObjectValue(truncation, "lastLinePartial");
    const requestedRange =
      !truncated && /^\d+ more lines in file\. Use offset=\d+ to continue\.$/u.test(notice);
    const linePage =
      truncated &&
      getObjectValue(truncation, "truncatedBy") === "lines" &&
      /^Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.$/u.test(notice);
    // Byte pagination is safe only when the host confirms complete returned lines.
    // Do not classify arbitrary parenthetical recovery text as a size-limit footer.
    const bytePage =
      truncated &&
      getObjectValue(truncation, "truncatedBy") === "bytes" &&
      lastLinePartial === false &&
      /^Showing lines \d+-\d+ of \d+ \(\d+(?:\.\d+)?(?:B|KB|MB) limit\)\. Use offset=\d+ to continue\.$/u.test(
        notice,
      );
    if (lastLinePartial !== true && (requestedRange || linePage || bytePage)) {
      const [, page = notice, next] =
        /^(.*?)\.? (Use offset=\d+ to continue\.)$/u.exec(notice) ?? [];
      return [
        {
          severity: "info",
          code: "read-continuation",
          message: escapeControlChars(page),
          ...(next && { detail: next }),
        },
      ];
    }
    return [
      {
        severity: "warning",
        code: "read-truncated",
        message: "Only part of the file was returned",
        detail: escapeControlChars(notice),
      },
    ];
  }
  // An unrecognized continuation stays in the expanded output; the truncation itself is a warning.
  return truncated
    ? [
        {
          severity: "warning",
          code: "read-truncated",
          message: "Only part of the file was returned",
        },
      ]
    : [];
}

export function outputLimitProjection<Details>(
  tool: "bash" | "grep" | "find" | "ls",
  details: Details,
) {
  const issues: CompactIssue[] = [];
  const counters: string[] = [];
  if (isTruncated(details))
    issues.push({
      severity: "warning",
      code: "output-truncated",
      message: "Output was cut off",
      detail: `Output truncated by ${tool}`,
    });
  if (tool === "bash") {
    const path = getObjectValue(details, "fullOutputPath");
    if (Predicate.isString(path) && path)
      issues.push({
        severity: "info",
        code: "retained-output",
        message: `Full output: ${escapeControlChars(path)}`,
      });
    return { issues, counters };
  }
  const field =
    tool === "grep"
      ? "matchLimitReached"
      : tool === "find"
        ? "resultLimitReached"
        : "entryLimitReached";
  const limit = getObjectValue(details, field);
  // A reached cap says nothing about the total or how many survived byte truncation.
  if (Predicate.isNumber(limit) && Number.isSafeInteger(limit) && limit > 0)
    counters.push(`limit reached: ${limit}`);
  if (tool === "grep" && getObjectValue(details, "linesTruncated") === true)
    issues.push({
      severity: "warning",
      code: "grep-partial-lines",
      message: "Some matching lines were cut off",
      detail: "Some lines truncated. Use read tool to see full lines.",
    });
  return { issues, counters };
}

export function writeDiffProjection<Before>(
  before: Before,
  content: string,
  policy: Omit<BuiltinCompactPolicy, "bashWarnings">,
) {
  const metadata: string[] = [];
  // Validate the owned skipped-snapshot shape before using its size evidence.
  // Do not classify prose reasons or let large new content mask missing history.
  const skipReason = getWriteDiffSkipReason(before, "", policy.maxWriteDiffBytes);
  if (skipReason !== undefined) {
    if (hasWriteDiffSizeEvidence(before))
      return {
        issues: secretIssues([skipReason], policy.secretWarnings, policy.secretScanChars),
        metadata: ["diff skipped: size"],
      };
    // Diff availability concerns the preview, not the write, so it is informational.
    const skipped: CompactIssue = {
      severity: "info",
      code: "write-diff-skipped",
      message: "Diff unavailable",
      detail: `Diff skipped: ${escapeControlChars(skipReason)}`,
    };
    return { issues: [skipped], metadata };
  }
  const beforeContent = getObjectValue(before, "content");
  if (getObjectValue(before, "kind") !== "content" || !Predicate.isString(beforeContent)) {
    const unavailable: CompactIssue = {
      severity: "info",
      code: "write-history-unavailable",
      message: "Diff unavailable: previous contents unknown",
    };
    return { issues: [unavailable], metadata };
  }
  const guard = getWriteDiffGuard(
    beforeContent,
    content,
    policy.maxWriteDiffBytes,
    policy.maxWriteDiffChangedLineCells,
  );
  if (guard) metadata.push(`diff skipped: ${guard}`);
  const none: CompactIssue[] = [];
  return { issues: none, metadata };
}
