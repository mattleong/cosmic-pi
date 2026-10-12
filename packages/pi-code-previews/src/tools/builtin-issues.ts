import * as Predicate from "effect/Predicate";
import { ownField, ownObject, type HostObject } from "../shared/untrusted-value";
import { escapeControlChars } from "../shared/terminal-text";
import { getBashWarnings } from "../warnings/bash";
import { getSecretWarnings } from "../warnings/secrets";
import { getWriteDiffGuard, getWriteDiffSkipReason, hasWriteDiffSizeEvidence } from "../write/diff";
import type { BuiltinCompactPolicy } from "./builtin-projection";
import type { CompactIssue } from "./compact-issues";
import { isTruncated, splitReadContinuationNotice } from "./data/results";

const VOWEL_SOUND = new Set(["AWS secret key", "API key"]);
const withArticle = (label: string) => `${VOWEL_SOUND.has(label) ? "an" : "a"} ${label}`;

export function secretIssues(
  sources: readonly string[],
  enabled: boolean,
  limit: number,
): CompactIssue[] {
  const warnings = new Set(
    enabled ? sources.flatMap((source) => getSecretWarnings(source, limit)) : [],
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

const READ_TRUNCATED: CompactIssue = {
  severity: "warning",
  code: "read-truncated",
  message: "Only part of the file was returned",
};

function oversizedFirstLineIssues(output: string): CompactIssue[] | undefined {
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

function isPagedNotice(
  notice: string,
  truncated: boolean,
  byLines: boolean,
  byWholeLineBytes: boolean,
): boolean {
  const requestedRange =
    !truncated && /^\d+ more lines in file\. Use offset=\d+ to continue\.$/u.test(notice);
  const linePage =
    truncated &&
    byLines &&
    /^Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.$/u.test(notice);
  const bytePage =
    truncated &&
    byWholeLineBytes &&
    /^Showing lines \d+-\d+ of \d+ \(\d+(?:\.\d+)?(?:B|KB|MB) limit\)\. Use offset=\d+ to continue\.$/u.test(
      notice,
    );
  return requestedRange || linePage || bytePage;
}

function continuationIssue(notice: string): CompactIssue {
  const [, page = notice, next] = /^(.*?)\.? (Use offset=\d+ to continue\.)$/u.exec(notice) ?? [];
  return {
    severity: "info",
    code: "read-continuation",
    message: escapeControlChars(page),
    ...(next && { detail: next }),
  };
}

export function readIssues(
  details: HostObject | undefined,
  output: string,
  hasLimit: boolean,
): CompactIssue[] | undefined {
  const truncation = ownObject(details, "truncation");
  if (ownField(truncation, "firstLineExceedsLimit") === true)
    return oversizedFirstLineIssues(output);
  const truncated = isTruncated(details);
  if (!truncated && !hasLimit) return [];
  const { notice } = splitReadContinuationNotice(output);
  if (notice) {
    const lastLinePartial = ownField(truncation, "lastLinePartial");
    const truncatedBy = truncated ? ownField(truncation, "truncatedBy") : undefined;
    const paged = isPagedNotice(
      notice,
      truncated,
      truncatedBy === "lines",
      truncatedBy === "bytes" && lastLinePartial === false,
    );
    if (lastLinePartial !== true && paged) return [continuationIssue(notice)];
    return [{ ...READ_TRUNCATED, detail: escapeControlChars(notice) }];
  }
  return truncated ? [READ_TRUNCATED] : [];
}

const LIMIT_FIELDS = {
  grep: "matchLimitReached",
  find: "resultLimitReached",
  ls: "entryLimitReached",
} as const;

export function outputLimitProjection(
  tool: "bash" | "grep" | "find" | "ls",
  details: HostObject | undefined,
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
    const path = ownField(details, "fullOutputPath");
    if (Predicate.isString(path) && path)
      issues.push({
        severity: "info",
        code: "retained-output",
        message: `Full output: ${escapeControlChars(path)}`,
      });
    return { issues, counters };
  }
  const field = LIMIT_FIELDS[tool];
  const limit = ownField(details, field);
  if (Predicate.isNumber(limit) && Number.isSafeInteger(limit) && limit > 0)
    counters.push(`limit reached: ${limit}`);
  if (tool === "grep" && ownField(details, "linesTruncated") === true)
    issues.push({
      severity: "warning",
      code: "grep-partial-lines",
      message: "Some matching lines were cut off",
      detail: "Some lines truncated. Use read tool to see full lines.",
    });
  return { issues, counters };
}

export function writeDiffProjection(
  before: HostObject | undefined,
  content: string,
  policy: Omit<BuiltinCompactPolicy, "bashWarnings">,
) {
  const skipReason = getWriteDiffSkipReason(before, "", policy.maxWriteDiffBytes);
  if (skipReason !== undefined) {
    if (hasWriteDiffSizeEvidence(before))
      return {
        issues: secretIssues([skipReason], policy.secretWarnings, policy.secretScanChars),
        metadata: ["diff skipped: size"],
      };
    const skipped = {
      severity: "info",
      code: "write-diff-skipped",
      message: "Diff unavailable",
      detail: `Diff skipped: ${escapeControlChars(skipReason)}`,
    } satisfies CompactIssue;
    return { issues: [skipped], metadata: [] };
  }
  const beforeContent = ownField(before, "content");
  if (ownField(before, "kind") !== "content" || !Predicate.isString(beforeContent)) {
    const unavailable = {
      severity: "info",
      code: "write-history-unavailable",
      message: "Diff unavailable: previous contents unknown",
    } satisfies CompactIssue;
    return { issues: [unavailable], metadata: [] };
  }
  const guard = getWriteDiffGuard(
    beforeContent,
    content,
    policy.maxWriteDiffBytes,
    policy.maxWriteDiffChangedLineCells,
  );
  return { issues: [], metadata: guard ? [`diff skipped: ${guard}`] : [] };
}
