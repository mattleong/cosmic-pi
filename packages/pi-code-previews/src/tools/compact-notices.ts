import * as Predicate from "effect/Predicate";
import { codePreviewSettings } from "../config/state";
import { codePreviewPerformanceConfig } from "../config/env";
import { getObjectValue } from "../shared/helpers";
import { escapeControlChars } from "../shared/terminal-text";
import { getBashWarnings } from "../warnings/bash";
import {
  getWriteDiffSkipReason,
  shouldSkipWriteDiffBytes,
  shouldSkipWriteDiffComplexity,
} from "../write/diff";
import type { CompactNotice } from "./compact-summary";
import { isTruncated, splitReadContinuationNotice } from "./data/results";
import { getPreviewSecretWarnings } from "./renderers/shared/secret-preview";

export function secretNotices(sources: readonly string[]): CompactNotice[] {
  const warnings = new Set(sources.flatMap(getPreviewSecretWarnings));
  return warnings.size > 0
    ? [{ kind: "warning", text: `Possible ${[...warnings].join(", ")}` }]
    : [];
}

export function bashCommandNotices(command: string): CompactNotice[] | undefined {
  if (!codePreviewSettings.bashWarnings) return [];
  // Do not partially scan a command and hide warnings in its unscanned middle.
  if (command.length > 16 * 1024) return undefined;
  return getBashWarnings(command).map((text) => ({ kind: "warning", text }));
}

export function readNotices<Details>(
  details: Details,
  output: string,
  hasLimit: boolean,
): CompactNotice[] | undefined {
  const truncation = getObjectValue(details, "truncation");
  if (getObjectValue(truncation, "firstLineExceedsLimit") === true) {
    // This successful read contains only the host's bash recovery instruction.
    return output ? [{ kind: "recovery", text: escapeControlChars(output) }] : undefined;
  }
  const truncated = isTruncated(details);
  if (!truncated && !hasLimit) return [];
  const { notice } = splitReadContinuationNotice(output);
  if (notice) {
    // Ordinary range/line pagination is informational. Keep it in the original output,
    // not the compact attention rows. Byte caps and unknown truncation remain visible.
    const requestedRange = !truncated && /^\d+ more lines in file\./u.test(notice);
    const linePage =
      truncated &&
      getObjectValue(truncation, "truncatedBy") === "lines" &&
      /^Showing lines \d+-\d+ of \d+\. Use offset=\d+ to continue\.$/u.test(notice);
    if (requestedRange || linePage) return [];
    return [{ kind: "recovery", text: escapeControlChars(notice) }];
  }
  // An unrecognized host continuation may contain recovery detail we cannot summarize.
  return truncated ? undefined : [];
}

export function outputLimitNotices<Details>(
  tool: "bash" | "grep" | "find" | "ls",
  details: Details,
): CompactNotice[] {
  const notices: CompactNotice[] = [];
  if (isTruncated(details)) notices.push({ kind: "warning", text: `Output truncated by ${tool}` });
  if (tool === "bash") {
    const path = getObjectValue(details, "fullOutputPath");
    if (Predicate.isString(path) && path)
      notices.push({ kind: "recovery", text: `Full output: ${escapeControlChars(path)}` });
    return notices;
  }
  const field =
    tool === "grep"
      ? "matchLimitReached"
      : tool === "find"
        ? "resultLimitReached"
        : "entryLimitReached";
  const limit = getObjectValue(details, field);
  if (Predicate.isNumber(limit) && Number.isFinite(limit) && limit > 0) {
    const noun = tool === "grep" ? "matches" : tool === "find" ? "results" : "entries";
    const recovery = Number.isSafeInteger(limit * 2)
      ? `Use limit=${limit * 2} for more${tool === "grep" ? ", or refine pattern" : ""}.`
      : "Increase limit or narrow the search.";
    notices.push({ kind: "recovery", text: `${limit} ${noun} limit reached. ${recovery}` });
  }
  if (tool === "grep" && getObjectValue(details, "linesTruncated") === true)
    notices.push({
      kind: "recovery",
      text: "Some lines truncated. Use read tool to see full lines.",
    });
  return notices;
}

export function writeDiffNotices<Before>(before: Before, content: string): CompactNotice[] {
  // UTF-16 length is a cheap lower bound on UTF-8 bytes. Keep later scans bounded.
  if (content.length > codePreviewPerformanceConfig.maxWriteDiffBytes)
    return [{ kind: "warning", text: "Write applied; diff skipped for large content" }];
  const skipReason = getWriteDiffSkipReason(before, content);
  if (skipReason)
    return [
      { kind: "warning", text: `Write applied; diff skipped: ${escapeControlChars(skipReason)}` },
    ];
  const beforeContent = getObjectValue(before, "content");
  if (!Predicate.isString(beforeContent))
    return [
      { kind: "warning", text: "Write applied; diff unavailable: previous content unavailable" },
    ];
  if (
    beforeContent.length > codePreviewPerformanceConfig.maxWriteDiffBytes ||
    shouldSkipWriteDiffBytes(beforeContent, content)
  )
    return [{ kind: "warning", text: "Write applied; diff skipped for large content" }];
  if (beforeContent !== content && shouldSkipWriteDiffComplexity(beforeContent, content))
    return [{ kind: "warning", text: "Write applied; diff skipped for complex rewrite" }];
  return [];
}
