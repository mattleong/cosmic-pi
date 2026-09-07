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
 * detached `events` slices; existing events are never modified.
 */
export class LogBuffer {
  private snapshot: ReadonlyArray<BackgroundLogEvent> | undefined;
  private store: BackgroundLogEvent[] = [];
  private start = 0;
  bytes = 0;
  droppedBytes = 0;
  nextCursor = 1;

  static empty(): LogBuffer {
    return new LogBuffer();
  }

  get events(): ReadonlyArray<BackgroundLogEvent> {
    return (this.snapshot ??= this.store.slice(this.start));
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
      this.store.push({
        cursor: this.nextCursor,
        stream,
        text: tail.text,
        timestamp,
        bytes: tail.bytes,
        ...((droppedBefore || tail.bytes < originalBytes) && { droppedBefore: true }),
      });
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
