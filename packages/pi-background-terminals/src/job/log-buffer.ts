import type {
  BackgroundLogEvent,
  BackgroundLogSlice,
  BackgroundLogStream,
  BackgroundJobState,
} from "./model.ts";

export interface LogBuffer {
  readonly events: ReadonlyArray<BackgroundLogEvent>;
  readonly bytes: number;
  readonly droppedBytes: number;
  readonly nextCursor: number;
}

export const emptyLogBuffer = (): LogBuffer => ({
  events: [],
  bytes: 0,
  droppedBytes: 0,
  nextCursor: 1,
});

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function utf8Tail(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly bytes: number } {
  if (maxBytes <= 0) return { text: "", bytes: 0 };
  const characters = [...text];
  let bytes = 0;
  let start = characters.length;
  while (start > 0) {
    const character = characters[start - 1] ?? "";
    const size = utf8ByteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return { text: characters.slice(start).join(""), bytes };
}

export function appendLog(
  current: LogBuffer,
  stream: BackgroundLogStream,
  text: string,
  timestamp: number,
  maxBytes: number,
): LogBuffer {
  if (!text) return current;
  const originalBytes = utf8ByteLength(text);
  const tail = utf8Tail(text, maxBytes);
  const event: BackgroundLogEvent = {
    cursor: current.nextCursor,
    stream,
    text: tail.text,
    timestamp,
    bytes: tail.bytes,
  };
  const events = [...current.events, ...(tail.text ? [event] : [])];
  let bytes = current.bytes + tail.bytes;
  let droppedBytes = current.droppedBytes + originalBytes - tail.bytes;
  while (events.length > 0 && bytes > maxBytes) {
    const removed = events.shift();
    if (!removed) break;
    bytes -= removed.bytes;
    droppedBytes += removed.bytes;
  }
  return {
    events,
    bytes,
    droppedBytes,
    nextCursor: current.nextCursor + 1,
  };
}

export function addDroppedLogBytes(current: LogBuffer, droppedBytes: number): LogBuffer {
  return droppedBytes > 0
    ? { ...current, droppedBytes: current.droppedBytes + droppedBytes }
    : current;
}

export function dropOldestLogEvent(current: LogBuffer): LogBuffer {
  const [first, ...events] = current.events;
  if (!first) return current;
  return {
    ...current,
    events,
    bytes: current.bytes - first.bytes,
    droppedBytes: current.droppedBytes + first.bytes,
  };
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
  state: BackgroundJobState,
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
    earliestAvailableCursor: buffer.events[0]?.cursor ?? buffer.nextCursor,
    droppedBytes: buffer.droppedBytes,
    state,
  };
}
