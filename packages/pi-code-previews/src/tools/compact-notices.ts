import * as Predicate from "effect/Predicate";
import { codePreviewSettings } from "../config/state";
import { codePreviewPerformanceConfig } from "../config/env";
import { getObjectValue } from "../shared/helpers";
import { escapeControlChars } from "../shared/terminal-text";
import { getBashWarnings } from "../warnings/bash";
import { getWriteDiffGuard, getWriteDiffSkipReason, hasWriteDiffSizeEvidence } from "../write/diff";
import type { CompactNotice } from "./compact-summary";
import { isTruncated, splitReadContinuationNotice } from "./data/results";
import { getPreviewSecretWarnings } from "./renderers/shared/secret-preview";

export function secretNotices(
  sources: readonly string[],
  enabled = codePreviewSettings.secretWarnings,
  limit = codePreviewPerformanceConfig.secretScanChars,
): CompactNotice[] {
  const warnings = new Set(
    sources.flatMap((source) => getPreviewSecretWarnings(source, enabled, limit)),
  );
  return warnings.size > 0
    ? [
        {
          code: "possible-secrets",
          kind: "warning",
          description: "This may contain sensitive information.",
          text: `Possible ${[...warnings].join(", ")}`,
        },
      ]
    : [];
}

export function bashCommandNotices(
  command: string,
  enabled = codePreviewSettings.bashWarnings,
): CompactNotice[] | undefined {
  if (!enabled) return [];
  // Do not partially scan a command and hide warnings in its unscanned middle.
  if (command.length > 16 * 1024) return undefined;
  return getBashWarnings(command).map((text, index) => ({
    code: `command-risk-${index}`,
    description: text,
    kind: "warning",
    text,
  }));
}

export function readNotices<Details>(
  details: Details,
  output: string,
  hasLimit: boolean,
): CompactNotice[] | undefined {
  const truncation = getObjectValue(details, "truncation");
  if (getObjectValue(truncation, "firstLineExceedsLimit") === true) {
    // This successful read contains only the host's bash recovery instruction.
    return output
      ? [
          {
            code: "oversized-first-line",
            kind: "recovery",
            description: "The first line is too large to display.",
            text: escapeControlChars(output),
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
    if (lastLinePartial !== true && (requestedRange || linePage || bytePage))
      return [
        {
          code: "read-continuation",
          kind: "recovery",
          text: escapeControlChars(notice),
          expandedOnly: true,
        },
      ];
    return [
      {
        code: "read-truncated",
        kind: "recovery",
        description: "Only part of the file was returned.",
        text: escapeControlChars(notice),
      },
    ];
  }
  // An unrecognized host continuation may contain recovery detail we cannot summarize.
  return truncated ? undefined : [];
}

interface CompactResultProjection {
  notices: CompactNotice[];
  metadata: string[];
  counters?: string[];
}

export function outputLimitProjection<Details>(
  tool: "bash" | "grep" | "find" | "ls",
  details: Details,
): CompactResultProjection {
  const notices: CompactNotice[] = [];
  const metadata: string[] = [];
  const counters: string[] = [];
  if (isTruncated(details))
    notices.push({
      code: "output-truncated",
      description: "Only part of the output was returned.",
      kind: "warning",
      text: `Output truncated by ${tool}`,
    });
  if (tool === "bash") {
    const path = getObjectValue(details, "fullOutputPath");
    if (Predicate.isString(path) && path)
      notices.push({
        code: "retained-output",
        kind: "recovery",
        text: `Full output: ${escapeControlChars(path)}`,
      });
    return { notices, metadata };
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
    notices.push({
      code: "grep-partial-lines",
      description: "Some matching lines were cut short.",
      kind: "recovery",
      text: "Some lines truncated. Use read tool to see full lines.",
    });
  return { notices, metadata, counters };
}

export function writeDiffProjection<Before>(
  before: Before,
  content: string,
  policy = {
    secretWarnings: codePreviewSettings.secretWarnings,
    secretScanChars: codePreviewPerformanceConfig.secretScanChars,
    maxWriteDiffBytes: codePreviewPerformanceConfig.maxWriteDiffBytes,
    maxWriteDiffChangedLineCells: codePreviewPerformanceConfig.maxWriteDiffChangedLineCells,
  },
): CompactResultProjection {
  // Validate the owned skipped-snapshot shape before using its size evidence.
  // Do not classify prose reasons or let large new content mask missing history.
  const skipReason = getWriteDiffSkipReason(before, "", policy.maxWriteDiffBytes);
  if (skipReason !== undefined) {
    if (hasWriteDiffSizeEvidence(before))
      return {
        notices: secretNotices([skipReason], policy.secretWarnings, policy.secretScanChars),
        metadata: ["diff skipped: size"],
      };
    return {
      notices: [
        {
          code: "write-diff-skipped",
          description: "The file was saved, but its changes cannot be previewed.",
          kind: "warning",
          text: `Write applied; diff skipped: ${escapeControlChars(skipReason)}`,
        },
      ],
      metadata: [],
    };
  }
  const beforeContent = getObjectValue(before, "content");
  if (getObjectValue(before, "kind") !== "content" || !Predicate.isString(beforeContent))
    return {
      notices: [
        {
          code: "write-history-unavailable",
          description: "The file was saved, but its previous contents are unavailable.",
          kind: "warning",
          text: "Write applied; diff unavailable: previous content unavailable",
        },
      ],
      metadata: [],
    };
  const guard = getWriteDiffGuard(
    beforeContent,
    content,
    policy.maxWriteDiffBytes,
    policy.maxWriteDiffChangedLineCells,
  );
  return { notices: [], metadata: guard ? [`diff skipped: ${guard}`] : [] };
}
