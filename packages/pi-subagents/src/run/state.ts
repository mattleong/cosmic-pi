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

export const MAX_NAME_CHARS = 80;
export const MAX_TASK_CHARS = 128 * 1024;
/**
 * The report text each run keeps in memory and in saved details, for human rendering and for
 * `agent_read`, which returns it whole when no report file was saved.
 */
export const MAX_FINAL_TEXT_CHARS = 16 * 1024;
/** The most of one report the archive saves; the parent reads reports from that file. */
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

const characterCount = (count: number): string => count.toLocaleString("en-US");

const savedFileText = (label: string, archive: SubagentReportArchive): string =>
  `${label}: ${sanitizeTerminalLine(archive.path)} (${characterCount(archive.chars)} characters, ${countLabel(archive.lines, "line")})`;

/**
 * The one pointer to a saved report, wherever a report reaches a parent, such as
 * `Read the full report: <path> (5,120 characters, 120 lines)`.
 */
export const reportFileText = (archive: SubagentReportArchive): string =>
  savedFileText(
    archive.complete ? "Read the full report" : "Read the report, cut at the 1 MiB archive limit",
    archive,
  );

/** The pointer to a failure too long to preview, such as `Read the full failure: <path> (…)`. */
export const failureFileText = (archive: SubagentReportArchive): string =>
  savedFileText("Read the full failure", archive);

/** How much of a cut report the run kept in memory, such as `16,384 of 90,000 characters kept`. */
export const reportTruncationText = (truncation: SubagentReportTruncation): string =>
  `${characterCount(truncation.retainedChars)} of ${characterCount(truncation.originalChars)} characters kept`;

/** Leads a report inlined because its file couldn't be saved. */
export const unsavedReportNote = (truncation: SubagentReportTruncation | undefined): string =>
  `[No report file was saved, so the report is inline${truncation ? `; ${reportTruncationText(truncation)}` : ""}.]`;

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
