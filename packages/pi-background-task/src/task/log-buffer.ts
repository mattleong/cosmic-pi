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
  BackgroundOutputSkip,
  BackgroundTaskState,
} from "./model.ts";
import { plainTerminalText } from "./terminal-text.ts";

const COMPACTION_MIN_DEAD_EVENTS = 32;
// Evicted cursors whose discard totals are kept, so a read from one of them reports exactly how
// much output it missed; a read from an older cursor gets a lower bound. The ledger starts small
// and doubles as evictions accumulate; a finished task keeps fewer, since its output is complete.
const LEDGER_INITIAL_CURSORS = 64;
const LEDGER_MAX_CURSORS = 4_096;
const LEDGER_FINISHED_CURSORS = 256;

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

/**
 * The discard total as each recent evicted cursor left. Cursors are evicted in order, one at a
 * time, so the ring holds the totals of the `count` newest evicted cursors, ending at `newest`.
 */
class DiscardLedger {
  private limit: number;
  private totals: Float64Array;
  private newest = 0;
  private count = 0;

  constructor(limit: number) {
    this.limit = limit;
    this.totals = new Float64Array(Math.min(LEDGER_INITIAL_CURSORS, limit));
  }

  /** The oldest cursor whose total is held. */
  get oldest(): number {
    return this.newest - this.count + 1;
  }

  /** The oldest total held, which bounds the total of any older cursor from above. */
  get oldestTotal(): number {
    return this.totalAt(this.oldest) ?? 0;
  }

  /** Records the total after evicting `cursor`, the cursor after the newest one recorded. */
  record(cursor: number, total: number): void {
    if (this.count === this.totals.length && this.count < this.limit)
      this.resize(Math.min(this.limit, this.count * 2));
    this.totals[cursor % this.totals.length] = total;
    this.newest = cursor;
    this.count = Math.min(this.count + 1, this.totals.length);
  }

  /** The total recorded for `cursor`, unless it is older than every total held. */
  totalAt(cursor: number): number | undefined {
    if (this.count === 0 || cursor < this.oldest || cursor > this.newest) return undefined;
    return this.totals[cursor % this.totals.length];
  }

  /** Holds at most the newest `capacity` totals from now on. */
  limitTo(capacity: number): void {
    this.limit = Math.min(this.limit, capacity);
    if (this.totals.length > this.limit) this.resize(this.limit);
  }

  private resize(capacity: number): void {
    const totals = new Float64Array(capacity);
    this.count = Math.min(this.count, capacity);
    for (let cursor = this.oldest; cursor <= this.newest; cursor += 1)
      totals[cursor % capacity] = this.totals[cursor % this.totals.length] ?? 0;
    this.totals = totals;
  }
}

/** The events holding a read's newest lines; see `LogBuffer.tail`. */
interface LogTail {
  readonly events: BackgroundLogEvent[];
  readonly fromOldest: boolean;
}

export class LogBuffer {
  private snapshot: ReadonlyArray<BackgroundLogEvent> | undefined;
  // Evicted slots are cleared at once so their text is released; compaction only reclaims slots.
  private store: Array<BackgroundLogEvent | undefined> = [];
  private start = 0;
  // Lost output that the next stored event follows.
  private pendingDroppedBytes = 0;
  // Output discarded up to and including the newest evicted event: everything before the oldest
  // retained event apart from the gap just before it.
  private discardedThroughEarliest = 0;
  // `discardedThroughEarliest` as it was when each recent evicted cursor left.
  private ledger: DiscardLedger | undefined;
  private ledgerCursors = LEDGER_MAX_CURSORS;
  // Each stream's newest evicted output ended a line, so its oldest retained output starts one.
  private readonly evictedEndsLine: Record<BackgroundLogStream, boolean> = {
    stdout: true,
    stderr: true,
  };
  bytes = 0;
  /** Output discarded over the task's life, including routine eviction of old output. */
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
          ...(this.pendingDroppedBytes > 0 && { droppedBefore: this.pendingDroppedBytes }),
        }),
      );
      this.pendingDroppedBytes = 0;
      this.bytes += bytes;
      this.nextCursor += 1;
    }
    this.evictOver(maxBytes);
    return this;
  }

  /**
   * Ends the task's output. Output lost after the newest event becomes a textless event with a
   * cursor of its own, so the read that reaches it reports the loss and the next read starts past
   * it. The ledger then keeps fewer cursors, which bounds what retained finished tasks hold.
   */
  finish(timestamp: number, maxBytes: number): LogBuffer {
    this.ledgerCursors = LEDGER_FINISHED_CURSORS;
    this.ledger?.limitTo(LEDGER_FINISHED_CURSORS);
    if (this.pendingDroppedBytes <= 0) return this;
    this.snapshot = undefined;
    this.store.push(
      Object.freeze({
        cursor: this.nextCursor,
        stream: this.store.at(-1)?.stream ?? "stdout",
        text: "",
        timestamp,
        bytes: 0,
        droppedBefore: this.pendingDroppedBytes,
      }),
    );
    this.pendingDroppedBytes = 0;
    this.nextCursor += 1;
    this.evictOver(maxBytes);
    return this;
  }

  private evictOver(maxBytes: number): void {
    while (this.chargedBytes > maxBytes && this.oldestEvent) this.dropOldest();
  }

  /** Counts output lost before reaching the buffer; the next stored event follows a gap. */
  addDropped(droppedBytes: number): LogBuffer {
    if (droppedBytes > 0) {
      this.droppedBytes += droppedBytes;
      this.pendingDroppedBytes += droppedBytes;
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
    this.discardedThroughEarliest += (first.droppedBefore ?? 0) + first.bytes;
    (this.ledger ??= new DiscardLedger(this.ledgerCursors)).record(
      first.cursor,
      this.discardedThroughEarliest,
    );
    // Lost output may have held either stream's text, so neither is known to end a line.
    if (first.droppedBefore) this.evictedEndsLine.stdout = this.evictedEndsLine.stderr = false;
    this.evictedEndsLine[first.stream] = Fn.pipe(plainTerminalText(first.text), Str.endsWith("\n"));
    if (this.start > COMPACTION_MIN_DEAD_EVENTS && this.start * 2 > this.store.length) {
      this.store = this.store.slice(this.start);
      this.start = 0;
    }
    return this;
  }

  /**
   * Output discarded after `cursor` and before the oldest retained event, which is none unless
   * eviction has passed `cursor`. Every cursor up to the earliest was evicted, so the ledger
   * holds the newest of them; an older cursor gets a lower bound.
   */
  discardedSince(cursor: number): BackgroundOutputSkip | undefined {
    if (cursor >= this.earliestCursor) return undefined;
    const exact = cursor <= 0 ? 0 : this.ledger?.totalAt(cursor);
    const before = exact ?? this.ledger?.oldestTotal ?? 0;
    const bytes = this.discardedThroughEarliest - before;
    if (bytes <= 0) return undefined;
    return exact === undefined ? { bytes, atLeast: true } : { bytes };
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

  /**
   * The events holding the last `lineLimit` logical lines, trimming the first at a line start.
   * `fromOldest` means the lines reach back past the oldest retained event's start, so output
   * discarded before it may have held some of them. A textless event that ends the output, for
   * output lost at the end, is returned with the lines before it.
   */
  tail(lineLimit: number): LogTail {
    if (lineLimit <= 0) return { events: [], fromOldest: false };
    let newest = this.store.length - 1;
    while (newest > this.start && this.store[newest]?.text === "") newest -= 1;
    let ignoredBreaks = Fn.pipe(this.store[newest]?.text ?? "", Str.endsWith("\n")) ? 1 : 0;
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
        if (linesLeft === 0 && event)
          return { events: this.trimmedFrom(index, event, newline + 1), fromOldest: false };
      }
    }
    // The oldest retained line completes the request when nothing before it was cut off.
    const whole = linesLeft === 1 && this.oldestLineWhole();
    return { events: this.range(this.start), fromOldest: !whole };
  }

  /**
   * Whether the oldest retained line holds all of its output: no gap precedes it, and each stream
   * it holds had ended its evicted output with a line break.
   */
  private oldestLineWhole(): boolean {
    if (this.size === 0 || this.oldestEvent?.droppedBefore) return false;
    const seen: Record<BackgroundLogStream, boolean> = { stdout: false, stderr: false };
    for (let index = this.start; index < this.store.length; index += 1) {
      const event = this.store[index];
      if (!event) continue;
      if (!seen[event.stream] && !this.evictedEndsLine[event.stream]) return false;
      seen[event.stream] = true;
      if (indexOfFrom(event.text, "\n", 0) >= 0) return true;
    }
    return true;
  }

  /**
   * The events from `index`, the first cut to start at `offset`. A cut event starts after a line
   * break inside it, so the gap before the whole event is not part of the lines read.
   */
  private trimmedFrom(
    index: number,
    event: BackgroundLogEvent,
    offset: number,
  ): BackgroundLogEvent[] {
    const rest = this.range(index + 1);
    if (offset >= event.text.length) return rest;
    const text = Fn.pipe(event.text, Str.slice(offset));
    const { cursor, stream, timestamp } = event;
    const bytes = utf8ByteLength(text);
    return [Object.freeze({ cursor, stream, text, timestamp, bytes }), ...rest];
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

/**
 * Reads after `afterCursor`, or else the last `tailLines` lines. The slice records the discarded
 * output the read asked for: each event's gap and, in `discardedBefore`, the output discarded
 * after the cursor, or before lines that reach past the oldest retained event.
 */
export function readLogBuffer(
  id: string,
  buffer: LogBuffer,
  state: BackgroundTaskState,
  options: { readonly afterCursor?: number; readonly tailLines?: number },
): BackgroundLogSlice {
  const { afterCursor } = options;
  const { events, fromOldest } =
    afterCursor === undefined
      ? buffer.tail(options.tailLines ?? 200)
      : { events: buffer.eventsAfter(afterCursor), fromOldest: true };
  const discardedBefore = fromOldest ? buffer.discardedSince(afterCursor ?? 0) : undefined;
  return Object.freeze({
    id,
    events: Object.freeze(events),
    nextCursor: buffer.latestCursor,
    earliestAvailableCursor: buffer.earliestCursor,
    droppedBytes: buffer.droppedBytes,
    retainedBytes: buffer.bytes,
    ...(discardedBefore && { discardedBefore }),
    state,
  });
}

/**
 * The discarded output that the events `from` up to `to` of a slice skip: each one's gap, and the
 * output discarded before the slice when they start with its first event. Output lost after the
 * newest event belongs to whatever follows it, so a chain of reads reports each gap once.
 */
export const skippedWithin = (
  slice: Pick<BackgroundLogSlice, "events" | "discardedBefore">,
  from = 0,
  to = slice.events.length,
): BackgroundOutputSkip | undefined => {
  const before = from === 0 ? slice.discardedBefore : undefined;
  let bytes = before?.bytes ?? 0;
  for (let index = from; index < to; index += 1) bytes += slice.events[index]?.droppedBefore ?? 0;
  if (bytes <= 0) return undefined;
  return before?.atLeast ? { bytes, atLeast: true } : { bytes };
};
