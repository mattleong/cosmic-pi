import type {
  BackgroundLogEvent,
  BackgroundLogSlice,
  BackgroundLogStream,
  BackgroundTaskState,
} from "./model.ts";
import { utf8ByteLength, utf8Tail } from "./utf8.ts";

/** Compact the store once the dead prefix outweighs the live events. */
const COMPACTION_MIN_DEAD_EVENTS = 32;

/**
 * Retained log events for one task.
 *
 * The service mutates this buffer under its registry semaphore. An offset-backed
 * store makes appends and trims amortized O(1). Consumers retain only cached,
 * detached frozen `events` slices sharing events frozen at creation.
 */
export class LogBuffer {
  private snapshot: ReadonlyArray<BackgroundLogEvent> | undefined;
  private store: BackgroundLogEvent[] = [];
  private start = 0;
  bytes = 0;
  droppedBytes = 0;
  nextCursor = 1;

  get events(): ReadonlyArray<BackgroundLogEvent> {
    return (this.snapshot ??= Object.freeze(this.store.slice(this.start)));
  }

  get oldestEvent(): BackgroundLogEvent | undefined {
    return this.store[this.start];
  }

  append(
    stream: BackgroundLogStream,
    text: string,
    timestamp: number,
    maxBytes: number,
    droppedBefore = false,
  ): LogBuffer {
    if (!text) return this;
    const originalBytes = utf8ByteLength(text);
    const tail = utf8Tail(text, maxBytes);
    if (tail.text) {
      this.snapshot = undefined;
      this.store.push(
        Object.freeze({
          cursor: this.nextCursor,
          stream,
          text: tail.text,
          timestamp,
          bytes: tail.bytes,
          ...((droppedBefore || tail.bytes < originalBytes) && { droppedBefore: true as const }),
        }),
      );
    }
    this.bytes += tail.bytes;
    this.droppedBytes += originalBytes - tail.bytes;
    this.nextCursor += 1;
    while (this.bytes > maxBytes && this.oldestEvent) this.dropOldest();
    return this;
  }

  addDropped(droppedBytes: number): LogBuffer {
    if (droppedBytes > 0) this.droppedBytes += droppedBytes;
    return this;
  }

  dropOldest(): LogBuffer {
    const first = this.oldestEvent;
    if (!first) return this;
    this.snapshot = undefined;
    this.start += 1;
    this.bytes -= first.bytes;
    this.droppedBytes += first.bytes;
    if (this.start > COMPACTION_MIN_DEAD_EVENTS && this.start * 2 > this.store.length) {
      this.store = this.store.slice(this.start);
      this.start = 0;
    }
    return this;
  }
}

/** Events from `index`, with the first clipped to start at `offset` in its text. */
function eventsFrom(
  events: ReadonlyArray<BackgroundLogEvent>,
  index: number,
  offset: number,
): ReadonlyArray<BackgroundLogEvent> {
  const first = events[index];
  if (!first || offset >= first.text.length) return events.slice(index + 1);
  const text = first.text.slice(offset);
  return [
    Object.freeze({ ...first, text, bytes: utf8ByteLength(text) }),
    ...events.slice(index + 1),
  ];
}

/** The last `lineLimit` logical lines of the combined text; lines may span chunks. */
function tailEvents(
  events: ReadonlyArray<BackgroundLogEvent>,
  lineLimit: number,
): ReadonlyArray<BackgroundLogEvent> {
  if (lineLimit <= 0) return [];
  // A final newline ends the last line rather than starting another.
  let ignoredBreaks = events.at(-1)?.text.endsWith("\n") ? 1 : 0;
  let linesLeft = lineLimit;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = events[index]?.text ?? "";
    for (let end = text.length; end > 0; ) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline < 0) break;
      end = newline;
      if (ignoredBreaks > 0) {
        ignoredBreaks -= 1;
        continue;
      }
      linesLeft -= 1;
      if (linesLeft === 0) return eventsFrom(events, index, newline + 1);
    }
  }
  return events.slice();
}

export function readLogBuffer(
  id: string,
  buffer: LogBuffer,
  state: BackgroundTaskState,
  options: { readonly afterCursor?: number; readonly tailLines?: number },
): BackgroundLogSlice {
  const filtered =
    options.afterCursor === undefined
      ? tailEvents(buffer.events, options.tailLines ?? 200)
      : buffer.events.filter((event) => event.cursor > options.afterCursor!);
  return Object.freeze({
    id,
    events: Object.freeze(filtered),
    nextCursor: buffer.nextCursor - 1,
    earliestAvailableCursor: buffer.oldestEvent?.cursor ?? buffer.nextCursor,
    droppedBytes: buffer.droppedBytes,
    state,
  });
}
