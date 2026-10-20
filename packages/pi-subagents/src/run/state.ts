import {
  countLabel,
  freezeSnapshot,
  safeTextPrefix,
  safeTextSuffix,
  sanitizeDiagnosticError,
  sanitizeTerminalLine,
  stripTerminalControls,
  utf8ByteLength,
  utf8Prefix,
  clipText,
} from "pi-cosmic-core";
import type {
  SubagentReportArchive,
  SubagentReportTruncation,
  SubagentRunView,
  SubagentUsage,
} from "./model.ts";
import { MAX_TOOL_OUTPUT_CHARS } from "./limits.ts";

export const MAX_NAME_CHARS = 80;
export const MAX_TASK_CHARS = 128 * 1024;
/**
 * What a lone `agent_await` result keeps beside its report that a fitted card never clips: the
 * progress summary and at most 12 run rows (13 × 257), a quarantined run's cleanup guidance
 * (about 1,700), the card header (512), its lineage, resume, retry, workspace-proposal, and
 * steering lines (about 900), the shortened-fields marker and labels (about 200), and the
 * report-cut line, leaving about 1,300 for its archive path. Warnings, route warnings, cwd, and
 * diff-stat lines are diagnostics, clipped to the room that remains.
 */
export const REPORT_FRAMING_CHARS = 8_000;
/**
 * The report text each run keeps in memory and in saved details: the tool output that remains
 * after that framing, so a single-run `agent_await` always delivers a whole retained report.
 * Longer reports are archived, and Claude and Codex reports are limited to it.
 */
export const MAX_FINAL_TEXT_CHARS = MAX_TOOL_OUTPUT_CHARS - REPORT_FRAMING_CHARS;
/** The most of one report the archive saves; the in-memory cap only clips what stays in context. */
export const MAX_ARCHIVED_REPORT_CHARS = 1024 * 1024;
export const MAX_ERROR_CHARS = 8 * 1024;

export const clipWithMarker = (value: string, maximum: number, marker: string): string =>
  value.length <= maximum
    ? value
    : `${safeTextPrefix(value, Math.max(0, maximum - marker.length))}${marker}`;

export const clipUtf8Text = (value: string, maximumBytes: number): string => {
  if (utf8ByteLength(value) <= maximumBytes) return value;
  const marker = "…";
  const prefix = utf8Prefix(value, Math.max(0, maximumBytes - utf8ByteLength(marker)));
  return `${prefix}${marker}`;
};

export const sanitizeName = (value: string): string => {
  let sanitized = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    sanitized += code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }
  return safeTextPrefix(sanitized.replace(/\s+/g, " ").trim(), MAX_NAME_CHARS);
};

const frozenViewSnapshots = new WeakMap<SubagentRunView, SubagentRunView>();

export const snapshotView = (view: SubagentRunView): SubagentRunView => {
  const cached = frozenViewSnapshots.get(view);
  if (cached) return cached;
  const snapshot = freezeSnapshot(view);
  frozenViewSnapshots.set(view, snapshot);
  return snapshot;
};

export const sanitizeDiagnosticText = (value: string, limit: number): string => {
  const sanitized = sanitizeDiagnosticError(value, { maximumLength: limit + 2 });
  return clipText(sanitized, limit);
};

export const sanitizeStreamDiagnostic = (value: string, limit: number): string => {
  const sanitized = sanitizeDiagnosticError(value, { maximumLength: Number.MAX_SAFE_INTEGER });
  if (sanitized.length <= limit) return sanitized;
  const marker = " … ";
  const budget = Math.max(0, limit - marker.length);
  const head = Math.ceil(budget / 2);
  return `${safeTextPrefix(sanitized, head).trimEnd()}${marker}${safeTextSuffix(sanitized, budget - head).trimStart()}`;
};

export const sanitizeOutputText = (value: string, limit: number): string =>
  clipText(stripTerminalControls(value), limit);

/** The size of output text before the archive cap cut it. */
export interface OriginalTextSize {
  readonly chars: number;
  readonly lines: number;
}

/** Sanitized output text within the archive cap, with its original size when that cap cut it. */
export interface BoundedOutputText {
  readonly text: string;
  readonly originalSize?: OriginalTextSize | undefined;
}

/** Assistant output as a run retains it: the in-memory text and, when that was cut, its fuller copy. */
export interface CapturedOutputText {
  readonly text: string;
  readonly truncation?: SubagentReportTruncation | undefined;
  /** The text up to the archive cap, held only while `text` is cut and until it is archived. */
  readonly fullText?: string | undefined;
}

const lineCount = (value: string): number => {
  let lines = 1;
  for (let index = value.indexOf("\n"); index !== -1; index = value.indexOf("\n", index + 1))
    lines += 1;
  return lines;
};

/**
 * Backends sanitize and bound assistant output once, where it enters, so no event or settlement
 * they hold carries more than the archive cap.
 */
export const boundOutputText = (value: string): BoundedOutputText => {
  const text = stripTerminalControls(value).trim();
  if (text.length <= MAX_ARCHIVED_REPORT_CHARS) return { text };
  return {
    text: safeTextPrefix(text, MAX_ARCHIVED_REPORT_CHARS),
    originalSize: { chars: text.length, lines: lineCount(text) },
  };
};

/** Splits bounded output into the run's retained text and, when that is cut, its archive copy. */
export const captureOutputText = ({
  text,
  originalSize,
}: BoundedOutputText): CapturedOutputText | undefined => {
  if (!text) return undefined;
  const originalChars = originalSize?.chars ?? text.length;
  if (originalChars <= MAX_FINAL_TEXT_CHARS) return { text };
  const retained = clipText(text, MAX_FINAL_TEXT_CHARS);
  return {
    text: retained,
    truncation: {
      retainedChars: retained.length,
      originalChars,
      originalLines: originalSize?.lines ?? lineCount(text),
    },
    fullText: text,
  };
};

/** Where a completed report was saved, such as `Full report (120 lines): <path>`. */
export const reportArchiveText = (archive: SubagentReportArchive): string =>
  `${archive.complete ? "Full report" : "Report saved up to the archive limit"} (${countLabel(archive.lines, "line")}): ${sanitizeTerminalLine(archive.path)}`;

const characterCount = (count: number): string => count.toLocaleString("en-US");

/** How much of a cut report the run kept, and where the rest can be read. */
export const reportTruncationText = (
  truncation: SubagentReportTruncation | undefined,
  archive: SubagentReportArchive | undefined,
): string | undefined => {
  if (truncation === undefined) return undefined;
  const kept = `${characterCount(truncation.retainedChars)} of ${characterCount(truncation.originalChars)} characters kept`;
  return `${kept}. ${archive ? reportArchiveText(archive) : "No full copy was saved."}`;
};

const isValidUsage = (usage: SubagentUsage): boolean =>
  [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  ) &&
  (usage.cost === undefined || (Number.isFinite(usage.cost) && usage.cost >= 0));

export const addUsage = (left: SubagentUsage, right: SubagentUsage): SubagentUsage => {
  if (!isValidUsage(right)) return left;
  const cost =
    left.cost === undefined && right.cost === undefined
      ? undefined
      : (left.cost ?? 0) + (right.cost ?? 0);
  const combined: SubagentUsage = {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(cost !== undefined && { cost }),
    ...((right.contextPercent ?? left.contextPercent) !== undefined && {
      contextPercent: right.contextPercent ?? left.contextPercent,
    }),
  };
  return isValidUsage(combined) ? combined : left;
};
