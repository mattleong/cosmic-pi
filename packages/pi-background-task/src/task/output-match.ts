import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { codeUnitAt, indexOfFrom, lastIndexOfFrom } from "pi-cosmic-core/text-scan";
import { BACKGROUND_TASK_FIELD_BOUNDS as BOUNDS } from "./bounds.ts";
import { skippedWithin } from "./log-buffer.ts";
import type { BackgroundLogSlice, BackgroundLogStream, BackgroundOutputSkip } from "./model.ts";

// Recent text each stream keeps: enough to match across writes and to show a matched line's start.
const LINE_CONTEXT_CHARS = BOUNDS.maxMatchedLineChars;
const NEWLINE = 0x0a;

export interface OutputMatch {
  readonly cursor: number;
  /** The alternative found. */
  readonly text: string;
  /** The plain output line holding the match, clipped around it. */
  readonly line: string;
}

interface Found {
  readonly index: number;
  readonly text: string;
}

/** The alternative that starts earliest in `text`, the first listed on a tie. */
const earliest = (text: string, alternatives: ReadonlyArray<string>): Found | undefined =>
  Arr.reduce(alternatives, undefined, (best: Found | undefined, alternative) =>
    Option.match(Fn.pipe(text, Str.indexOf(alternative)), {
      onNone: () => best,
      onSome: (index) =>
        best === undefined || index < best.index ? { index, text: alternative } : best,
    }),
  );

/**
 * The line of `text` holding `found` as one display line, at most `maxMatchedLineChars`, keeping
 * the match in view when the line is longer. `clipped` means `text` does not start at a line
 * start, so a line that starts with `text` is shown as cut.
 */
const matchedLine = (text: string, found: Found, clipped: boolean): string => {
  const end = found.index + found.text.length;
  const lineBreak = found.index === 0 ? -1 : lastIndexOfFrom(text, "\n", found.index - 1);
  const lineStart = lineBreak + 1;
  const startCut = clipped && lineBreak < 0;
  const nextBreak = indexOfFrom(text, "\n", end);
  const lineEnd = nextBreak < 0 ? text.length : nextBreak;
  const limit = BOUNDS.maxMatchedLineChars;
  if (lineEnd - lineStart <= limit - Number(startCut)) {
    const line = sanitizeTerminalLine(Fn.pipe(text, Str.slice(lineStart, lineEnd)));
    return startCut ? `…${line}` : line;
  }
  // Room for an ellipsis at each cut end, with a quarter of the rest before the match.
  const room = limit - 2;
  const start = Math.max(lineStart, Math.min(found.index - Math.floor(room / 4), lineEnd - room));
  const stop = Math.min(lineEnd, start + room);
  const window = sanitizeTerminalLine(Fn.pipe(text, Str.slice(start, stop)));
  return `${start > lineStart || startCut ? "…" : ""}${window}${stop < lineEnd ? "…" : ""}`;
};

/** Where an output scan starts. */
export interface OutputScanStart {
  readonly afterCursor: number;
  /** Whether each stream's output up to `afterCursor` ended a line. */
  readonly linesEnded?: Readonly<Record<BackgroundLogStream, boolean>>;
  /** Lost output just after `afterCursor` that the scan did not ask for. */
  readonly ignoredGapBytes?: number;
}

/** Matches literal text in the plain output readers see, per stream and never across a gap. */
export class OutputMatcher {
  private readonly recent = { stdout: "", stderr: "" } satisfies Record<
    BackgroundLogStream,
    string
  >;
  // The kept text of a stream does not start at a line start.
  private readonly clipped: Record<BackgroundLogStream, boolean>;
  private readonly alternatives: ReadonlyArray<string>;
  private readonly kept: number;
  private scannedCursor: number;
  // Discarded output from the starting cursor through the slices scanned, each gap counted once.
  private skippedBytes = 0;
  private skippedAtLeast = false;
  // Counted out of the first slice, which always holds it.
  private ignoredGapBytes: number;

  constructor(alternatives: ReadonlyArray<string>, start: OutputScanStart) {
    const linesEnded = start.linesEnded ?? { stdout: true, stderr: true };
    this.alternatives = alternatives;
    this.clipped = { stdout: !linesEnded.stdout, stderr: !linesEnded.stderr };
    const longest = Arr.reduce(alternatives, 0, (max, text) => Math.max(max, text.length));
    // Every match found ends in the newest event: the kept text was already searched.
    this.kept = Math.max(longest - 1, LINE_CONTEXT_CHARS);
    this.scannedCursor = start.afterCursor;
    this.ignoredGapBytes = start.ignoredGapBytes ?? 0;
  }

  get afterCursor(): number {
    return this.scannedCursor;
  }

  /**
   * Output after the starting cursor and through the newest slice scanned that was discarded
   * before the scan reached it, including output after a match, which the result moves past.
   */
  get skipped(): BackgroundOutputSkip | undefined {
    const bytes = this.skippedBytes;
    if (bytes <= 0) return undefined;
    return this.skippedAtLeast ? { bytes, atLeast: true } : { bytes };
  }

  /** Scans a slice read after `afterCursor`. */
  match(slice: BackgroundLogSlice): OutputMatch | undefined {
    if (this.alternatives.length === 0) return undefined;
    this.countSkipped(slice);
    if (slice.earliestAvailableCursor > this.scannedCursor) this.reset();
    let match: OutputMatch | undefined;
    for (const event of slice.events) {
      if (event.droppedBefore) this.reset();
      const candidate = this.recent[event.stream] + event.text;
      const found = earliest(candidate, this.alternatives);
      if (found) {
        const line = matchedLine(candidate, found, this.clipped[event.stream]);
        match = { cursor: event.cursor, text: found.text, line };
        break;
      }
      const cut = candidate.length - this.kept;
      if (cut > 0) {
        this.clipped[event.stream] = codeUnitAt(candidate, cut - 1) !== NEWLINE;
        this.recent[event.stream] = Fn.pipe(candidate, Str.slice(cut));
      } else this.recent[event.stream] = candidate;
    }
    this.scannedCursor = Math.max(this.scannedCursor, slice.nextCursor);
    return match;
  }

  private countSkipped(slice: BackgroundLogSlice): void {
    const skipped = skippedWithin(slice);
    const ignored = this.ignoredGapBytes;
    this.ignoredGapBytes = 0;
    if (!skipped) return;
    this.skippedBytes += Math.max(0, skipped.bytes - ignored);
    this.skippedAtLeast ||= skipped.atLeast === true;
  }

  // Output was lost, so no stream's next text is known to start a line.
  private reset(): void {
    this.recent.stdout = "";
    this.recent.stderr = "";
    this.clipped.stdout = true;
    this.clipped.stderr = true;
  }
}
