import type {
  BackgroundLogEvent,
  BackgroundLogSlice,
  BackgroundLogStream,
  BackgroundTaskState,
} from "./model.ts";
import { utf8ByteLength, utf8Tail } from "./utf8.ts";

/** Compact the shared store once the dead prefix outweighs the live events. */
const COMPACTION_MIN_DEAD_EVENTS = 32;

/**
 * Retained log events for one task.
 *
 * Versions share one append-only backing store addressed by a live [start, end)
 * range, so appends and trims are amortized O(1) instead of copying every
 * retained event per chunk. `events` stays an immutable snapshot: the store is
 * never mutated at an index an existing version can observe.
 */
export class LogBuffer {
  private snapshot: ReadonlyArray<BackgroundLogEvent> | undefined;
  private readonly store: BackgroundLogEvent[];
  private readonly start: number;
  private readonly end: number;
  readonly bytes: number;
  readonly droppedBytes: number;
  readonly nextCursor: number;

  private constructor(
    store: BackgroundLogEvent[],
    start: number,
    end: number,
    bytes: number,
    droppedBytes: number,
    nextCursor: number,
  ) {
    this.store = store;
    this.start = start;
    this.end = end;
    this.bytes = bytes;
    this.droppedBytes = droppedBytes;
    this.nextCursor = nextCursor;
  }

  static empty(): LogBuffer {
    return new LogBuffer([], 0, 0, 0, 0, 1);
  }

  private static make(
    store: BackgroundLogEvent[],
    start: number,
    end: number,
    bytes: number,
    droppedBytes: number,
    nextCursor: number,
  ): LogBuffer {
    if (start > COMPACTION_MIN_DEAD_EVENTS && start * 2 > end) {
      return new LogBuffer(
        store.slice(start, end),
        0,
        end - start,
        bytes,
        droppedBytes,
        nextCursor,
      );
    }
    return new LogBuffer(store, start, end, bytes, droppedBytes, nextCursor);
  }

  get events(): ReadonlyArray<BackgroundLogEvent> {
    return (this.snapshot ??= this.store.slice(this.start, this.end));
  }

  get oldestEvent(): BackgroundLogEvent | undefined {
    return this.start < this.end ? this.store[this.start] : undefined;
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
    // Only the newest version may extend the shared store; an append onto an
    // older version copies its live range so existing snapshots stay intact.
    const reusable = this.end === this.store.length;
    const store = reusable ? this.store : this.store.slice(this.start, this.end);
    let start = reusable ? this.start : 0;
    let end = reusable ? this.end : this.end - this.start;
    if (tail.text) {
      store.push({
        cursor: this.nextCursor,
        stream,
        text: tail.text,
        timestamp,
        bytes: tail.bytes,
        ...((droppedBefore || tail.bytes < originalBytes) && { droppedBefore: true }),
      });
      end += 1;
    }
    let bytes = this.bytes + tail.bytes;
    let droppedBytes = this.droppedBytes + originalBytes - tail.bytes;
    while (start < end && bytes > maxBytes) {
      const removed = store[start];
      if (!removed) break;
      bytes -= removed.bytes;
      droppedBytes += removed.bytes;
      start += 1;
    }
    return LogBuffer.make(store, start, end, bytes, droppedBytes, this.nextCursor + 1);
  }

  addDropped(droppedBytes: number): LogBuffer {
    if (droppedBytes <= 0) return this;
    return LogBuffer.make(
      this.store,
      this.start,
      this.end,
      this.bytes,
      this.droppedBytes + droppedBytes,
      this.nextCursor,
    );
  }

  dropOldest(): LogBuffer {
    const first = this.oldestEvent;
    if (!first) return this;
    return LogBuffer.make(
      this.store,
      this.start + 1,
      this.end,
      this.bytes - first.bytes,
      this.droppedBytes + first.bytes,
      this.nextCursor,
    );
  }
}

function tailEvents(
  events: ReadonlyArray<BackgroundLogEvent>,
  lineLimit: number,
): ReadonlyArray<BackgroundLogEvent> {
  if (lineLimit <= 0) return [];
  let lines = 0;
  let start = events.length;
  while (start > 0 && lines < lineLimit) {
    start -= 1;
    const event = events[start];
    if (!event) continue;
    lines += Math.max(1, event.text.split("\n").length - 1);
  }
  const selected = events.slice(start);
  if (selected.length === 0 || lines <= lineLimit) return selected;
  const first = selected[0];
  if (!first) return selected;
  const parts = first.text.split("\n");
  const excess = lines - lineLimit;
  const text = parts.slice(Math.min(excess, parts.length - 1)).join("\n");
  return [{ ...first, text, bytes: utf8ByteLength(text) }, ...selected.slice(1)];
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
  return {
    id,
    events: filtered,
    nextCursor: buffer.nextCursor - 1,
    earliestAvailableCursor: buffer.oldestEvent?.cursor ?? buffer.nextCursor,
    droppedBytes: buffer.droppedBytes,
    state,
  };
}
