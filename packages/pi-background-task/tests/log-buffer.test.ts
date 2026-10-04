import { describe, expect, it } from "vitest";
import { LogBuffer, readLogBuffer } from "../src/task/log-buffer.ts";
import { utf8ByteLength } from "../src/task/utf8.ts";

describe("background log buffer", () => {
  it("counts UTF-8 bytes and retains a valid tail", () => {
    const buffer = new LogBuffer().append("stdout", "a🙂bc", 1, 6);
    expect(buffer.bytes).toBeLessThanOrEqual(6);
    expect(buffer.events[0]).toMatchObject({ text: "🙂bc", droppedBefore: true });
    expect(buffer.droppedBytes).toBe(1);
  });

  it("advances cursors and reports dropped events", () => {
    const buffer = new LogBuffer().append("stdout", "first\n", 1, 64);
    buffer.append("stderr", "second\n", 2, 64);
    buffer.dropOldest();
    const slice = readLogBuffer("task-1", buffer, "running", { afterCursor: 0 });
    expect(slice.events.map((event) => event.cursor)).toEqual([2]);
    expect(slice.earliestAvailableCursor).toBe(2);
    expect(slice.droppedBytes).toBe(utf8ByteLength("first\n"));
    expect(slice.nextCursor).toBe(2);
  });

  it("keeps detached snapshots through appends, eviction, and repeated compaction", () => {
    const buffer = new LogBuffer();
    for (let index = 0; index < 64; index++) buffer.append("stdout", "🙂", index, 256);
    const events = buffer.events;
    const original = events.map((event) => ({ ...event }));
    const slice = readLogBuffer("task-1", buffer, "running", { afterCursor: 0 });
    expect(buffer.events).toBe(events);

    for (let index = 64; index < 256; index++) buffer.append("stderr", "🙂", index, 256);
    for (let index = 0; index < 48; index++) buffer.dropOldest();
    buffer.addDropped(7).append("stdout", "done", 256, 256, true);

    expect(events).toEqual(original);
    expect(slice.events).toEqual(original);
    expect(slice).toMatchObject({ nextCursor: 64, earliestAvailableCursor: 1, droppedBytes: 0 });
    expect(buffer.events).toHaveLength(17);
    expect(buffer.events.at(-1)).toMatchObject({ cursor: 257, text: "done", droppedBefore: true });
    expect(buffer.bytes).toBe(68);
    expect(buffer.droppedBytes).toBe(967);
    expect(buffer.oldestEvent?.cursor).toBe(241);
    expect(buffer.nextCursor).toBe(258);
  });

  it("rejects consumer mutations without corrupting later reads or eviction accounting", () => {
    const buffer = new LogBuffer().append("stdout", "one\ntwo\n", 1, 8);
    const cached = buffer.events;
    const full = readLogBuffer("task-1", buffer, "running", { afterCursor: 0 });
    const tail = readLogBuffer("task-1", buffer, "running", { tailLines: 1 });
    const empty = readLogBuffer("task-1", buffer, "running", { tailLines: 0 });
    for (const events of [cached, full.events, tail.events, empty.events]) {
      expect(Reflect.set(events, "0", { text: "corrupted", bytes: 999 })).toBe(false);
      expect(Reflect.set(events, "length", 0)).toBe(false);
    }
    for (const event of [buffer.oldestEvent!, full.events[0]!, tail.events[0]!]) {
      expect(Reflect.set(event, "bytes", 999)).toBe(false);
      expect(Reflect.set(event, "text", "corrupted")).toBe(false);
      expect(Reflect.set(event, "cursor", 999)).toBe(false);
      expect(Reflect.set(event, "timestamp", 999)).toBe(false);
    }
    expect(Reflect.set(full, "droppedBytes", 999)).toBe(false);
    expect(buffer.bytes).toBe(8);
    expect(buffer.events).toEqual([
      { cursor: 1, stream: "stdout", text: "one\ntwo\n", timestamp: 1, bytes: 8 },
    ]);
    expect(tail.events[0]).toMatchObject({ text: "two\n", bytes: 4 });
    buffer.append("stderr", "🙂🙂", 2, 8);
    expect(readLogBuffer("task-1", buffer, "running", { afterCursor: 0 })).toMatchObject({
      events: [{ cursor: 2, text: "🙂🙂", bytes: 8 }],
      earliestAvailableCursor: 2,
      droppedBytes: 8,
    });
    expect(buffer.bytes).toBe(8);
    expect(cached[0]?.text).toBe("one\ntwo\n");
    expect(full).toMatchObject({ nextCursor: 1, droppedBytes: 0 });
    expect(tail.events[0]?.text).toBe("two\n");
  });

  it("returns a bounded line tail when no cursor is supplied", () => {
    const buffer = new LogBuffer();
    buffer.append("stdout", "one\ntwo\n", 1, 1024);
    buffer.append("stdout", "three\nfour\n", 2, 1024);
    const slice = readLogBuffer("task-1", buffer, "running", { tailLines: 2 });
    expect(slice.events.map((event) => event.text).join("")).toContain("four");
    expect(slice.events.map((event) => event.text).join("")).not.toContain("one");
  });

  it("tails logical lines that span chunks or end without a newline", () => {
    const tail = (buffer: LogBuffer, tailLines: number) =>
      readLogBuffer("task-1", buffer, "running", { tailLines })
        .events.map((event) => event.text)
        .join("");
    const open = new LogBuffer().append("stdout", "one\ntw", 1, 1024);
    open.append("stdout", "o\nthree\nfour", 2, 1024);
    expect(tail(open, 1)).toBe("four");
    expect(tail(open, 2)).toBe("three\nfour");
    expect(tail(open, 3)).toBe("two\nthree\nfour");
    expect(tail(open, 5)).toBe("one\ntwo\nthree\nfour");

    const terminated = new LogBuffer().append("stdout", "one\ntw", 1, 1024);
    terminated.append("stderr", "o\n", 2, 1024);
    expect(tail(terminated, 1)).toBe("two\n");
    expect(tail(terminated, 2)).toBe("one\ntwo\n");

    const boundary = new LogBuffer().append("stdout", "one\n", 1, 1024);
    boundary.append("stdout", "two\n", 2, 1024);
    expect(readLogBuffer("task-1", boundary, "running", { tailLines: 1 }).events).toMatchObject([
      { cursor: 2, text: "two\n" },
    ]);
  });
});
