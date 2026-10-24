import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { codeUnitAt, indexOfFrom, lastIndexOfFrom } from "pi-cosmic-core/text-scan";
import { utf8ByteLength, utf8Suffix } from "pi-cosmic-core/text";
import { BACKGROUND_LOG_BOUNDS as LOG_BOUNDS } from "./bounds.ts";
import type {
  BackgroundLogEvent,
  BackgroundLogSlice,
  BackgroundLogStream,
  BackgroundTaskState,
} from "./model.ts";
import { plainTerminalText } from "./terminal-text.ts";

const COMPACTION_MIN_DEAD_EVENTS = 32;

// Bound once: Pi's loader routes each call through an imported binding via an interop proxy,
// which dominates the per-character and per-line scans below.
const codeAt = codeUnitAt;
const lastIndexAt = lastIndexOfFrom;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * A copy of `text` decoded from its own bytes, sharing no storage with the string it was cut
 * from. A substring may keep its whole source alive, so a small retained event would otherwise
 * hold an entire large write in memory, outside the byte budget.
 */
export const ownedText = (text: string): string => utf8Decoder.decode(utf8Encoder.encode(text));

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * Where the stored event starting at `start` ends: within the byte and line bounds, at a line
 * break when one falls in the second half, and never inside an SGR sequence or surrogate pair.
 */
const eventEnd = (text: string, start: number, maxBytes: number, maxLines: number): number => {
  let bytes = 0;
  let lines = 0;
  let lineBreak = -1;
  let sequence = -1;
  let index = start;
  while (index < text.length) {
    const code = codeAt(text, index);
    const pair = isHighSurrogate(code) && isLowSurrogate(codeAt(text, index + 1));
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > maxBytes && index > start) break;
    bytes += size;
    if (code === 0x1b) sequence = index;
    else if (code === 0x6d) sequence = -1;
    index += pair ? 2 : 1;
    if (code === 0x0a) {
      lineBreak = index;
      lines += 1;
      if (lines >= maxLines) return index;
    }
  }
  if (index >= text.length) return text.length;
  if (sequence > start) return sequence;
  if (sequence === start) {
    const final = indexOfFrom(text, "m", sequence);
    return final < 0 ? index : final + 1;
  }
  return lineBreak > start + (index - start) / 2 ? lineBreak : index;
};

/** Splits normalized output into the bounded pieces stored as separate events. */
export const splitLogText = (
  text: string,
  maxBytes: number = LOG_BOUNDS.maxEventBytes,
  maxLines: number = LOG_BOUNDS.maxEventLines,
): string[] => {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; ) {
    const end = eventEnd(text, start, maxBytes, maxLines);
    pieces.push(Fn.pipe(text, Str.slice(start, end)));
    start = end;
  }
  return pieces;
};

/** The newest text within `maxBytes` that does not begin inside an SGR sequence. */
const styledSuffix = (text: string, maxBytes: number): string => {
  const suffix = utf8Suffix(text, maxBytes);
  const start = text.length - suffix.length;
  if (start === 0) return suffix;
  const escape = lastIndexOfFrom(text, "\u001b", start - 1);
  if (escape < 0) return suffix;
  const final = indexOfFrom(text, "m", escape);
  return final >= start ? Fn.pipe(text, Str.slice(final + 1)) : suffix;
};

export class LogBuffer {
  private snapshot: ReadonlyArray<BackgroundLogEvent> | undefined;
  // Evicted slots are cleared at once so their text is released; compaction only reclaims slots.
  private store: Array<BackgroundLogEvent | undefined> = [];
  private start = 0;
  private gapPending = false;
  bytes = 0;
  droppedBytes = 0;
  nextCursor = 1;

  get size(): number {
    return this.store.length - this.start;
  }

  /** Retained text plus a fixed per-event overhead, so floods of tiny writes stay bounded. */
  get chargedBytes(): number {
    return this.bytes + this.size * LOG_BOUNDS.eventOverheadBytes;
  }

  get latestCursor(): number {
    return this.nextCursor - 1;
  }

  /** The afterCursor value that reads from the oldest retained event. */
  get earliestCursor(): number {
    return (this.oldestEvent?.cursor ?? this.nextCursor) - 1;
  }

  get events(): ReadonlyArray<BackgroundLogEvent> {
    return (this.snapshot ??= Object.freeze(this.range(this.start)));
  }

  get oldestEvent(): BackgroundLogEvent | undefined {
    return this.store[this.start];
  }

  /** Stores normalized text as bounded events, keeping the newest that fit `maxBytes`. */
  append(
    stream: BackgroundLogStream,
    text: string,
    timestamp: number,
    maxBytes: number,
  ): LogBuffer {
    if (!text) return this;
    const pieces = splitLogText(text);
    const sizes = Arr.map(pieces, utf8ByteLength);
    let first = pieces.length;
    let charged = 0;
    while (first > 0) {
      const next = charged + (sizes[first - 1] ?? 0) + LOG_BOUNDS.eventOverheadBytes;
      if (next > maxBytes) break;
      charged = next;
      first -= 1;
    }
    if (first === pieces.length) {
      // Only a budget smaller than one event reaches this: keep what fits of the newest piece.
      const newest = pieces.at(-1) ?? "";
      const kept = styledSuffix(newest, maxBytes - LOG_BOUNDS.eventOverheadBytes);
      for (const bytes of sizes.slice(0, -1)) this.addDropped(bytes);
      this.addDropped((sizes.at(-1) ?? 0) - utf8ByteLength(kept));
      pieces.splice(0, pieces.length, kept);
      first = 0;
    } else for (const bytes of sizes.slice(0, first)) this.addDropped(bytes);
    for (const piece of pieces.slice(first)) {
      if (!piece) continue;
      this.snapshot = undefined;
      const bytes = utf8ByteLength(piece);
      this.store.push(
        Object.freeze({
          cursor: this.nextCursor,
          stream,
          text: ownedText(piece),
          timestamp,
          bytes,
          ...(this.gapPending && { droppedBefore: true as const }),
        }),
      );
      this.gapPending = false;
      this.bytes += bytes;
      this.nextCursor += 1;
    }
    while (this.chargedBytes > maxBytes && this.oldestEvent) this.dropOldest();
    return this;
  }

  /** Counts output lost before reaching the buffer; the next stored event follows a gap. */
  addDropped(droppedBytes: number): LogBuffer {
    if (droppedBytes > 0) {
      this.droppedBytes += droppedBytes;
      this.gapPending = true;
    }
    return this;
  }

  dropOldest(): LogBuffer {
    const first = this.oldestEvent;
    if (!first) return this;
    this.snapshot = undefined;
    this.store[this.start] = undefined;
    this.start += 1;
    this.bytes -= first.bytes;
    this.droppedBytes += first.bytes;
    if (this.start > COMPACTION_MIN_DEAD_EVENTS && this.start * 2 > this.store.length) {
      this.store = this.store.slice(this.start);
      this.start = 0;
    }
    return this;
  }

  /** Retained events after `cursor`, found by binary search without copying older events. */
  eventsAfter(cursor: number): BackgroundLogEvent[] {
    return this.range(this.indexAfter(cursor));
  }

  /**
   * Whether each stream's output up to `cursor` ends at a line break, so its next output starts a
   * line. A stream whose earlier output is no longer retained counts as not ending one.
   */
  linesEndedAt(cursor: number): Record<BackgroundLogStream, boolean> {
    const ended: Partial<Record<BackgroundLogStream, boolean>> = {};
    for (let index = this.indexAfter(cursor) - 1; index >= this.start; index -= 1) {
      const event = this.store[index];
      if (!event || ended[event.stream] !== undefined) continue;
      ended[event.stream] = Fn.pipe(plainTerminalText(event.text), Str.endsWith("\n"));
      if (ended.stdout !== undefined && ended.stderr !== undefined) break;
    }
    // With nothing evicted, a stream without earlier output starts a line.
    const complete = this.earliestCursor === 0;
    return { stdout: ended.stdout ?? complete, stderr: ended.stderr ?? complete };
  }

  private indexAfter(cursor: number): number {
    let low = this.start;
    let high = this.store.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.store[middle]?.cursor ?? Number.POSITIVE_INFINITY) > cursor) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /** The events holding the last `lineLimit` logical lines, trimming the first at a line start. */
  tail(lineLimit: number): BackgroundLogEvent[] {
    if (lineLimit <= 0) return [];
    let ignoredBreaks = Fn.pipe(this.store.at(-1)?.text ?? "", Str.endsWith("\n")) ? 1 : 0;
    let linesLeft = lineLimit;
    for (let index = this.store.length - 1; index >= this.start; index -= 1) {
      const event = this.store[index];
      const text = event?.text ?? "";
      for (let end = text.length; end > 0; ) {
        const newline = lastIndexAt(text, "\n", end - 1);
        if (newline < 0) break;
        end = newline;
        if (ignoredBreaks > 0) {
          ignoredBreaks -= 1;
          continue;
        }
        linesLeft -= 1;
        if (linesLeft === 0 && event) return this.trimmedFrom(index, event, newline + 1);
      }
    }
    return this.range(this.start);
  }

  private trimmedFrom(
    index: number,
    event: BackgroundLogEvent,
    offset: number,
  ): BackgroundLogEvent[] {
    const rest = this.range(index + 1);
    if (offset >= event.text.length) return rest;
    const text = Fn.pipe(event.text, Str.slice(offset));
    return [Object.freeze({ ...event, text, bytes: utf8ByteLength(text) }), ...rest];
  }

  private range(from: number): BackgroundLogEvent[] {
    const events: BackgroundLogEvent[] = [];
    for (let index = from; index < this.store.length; index += 1) {
      const event = this.store[index];
      if (event) events.push(event);
    }
    return events;
  }
}

export function readLogBuffer(
  id: string,
  buffer: LogBuffer,
  state: BackgroundTaskState,
  options: { readonly afterCursor?: number; readonly tailLines?: number },
): BackgroundLogSlice {
  const events =
    options.afterCursor === undefined
      ? buffer.tail(options.tailLines ?? 200)
      : buffer.eventsAfter(options.afterCursor);
  return Object.freeze({
    id,
    events: Object.freeze(events),
    nextCursor: buffer.latestCursor,
    earliestAvailableCursor: buffer.earliestCursor,
    droppedBytes: buffer.droppedBytes,
    retainedBytes: buffer.bytes,
    state,
  });
}
