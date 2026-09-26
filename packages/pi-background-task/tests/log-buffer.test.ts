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

  it("returns a bounded line tail when no cursor is supplied", () => {
    const buffer = new LogBuffer();
    buffer.append("stdout", "one\ntwo\n", 1, 1024);
    buffer.append("stdout", "three\nfour\n", 2, 1024);
    const slice = readLogBuffer("task-1", buffer, "running", { tailLines: 2 });
    expect(slice.events.map((event) => event.text).join("")).toContain("four");
    expect(slice.events.map((event) => event.text).join("")).not.toContain("one");
  });
});
