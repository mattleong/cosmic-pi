import { describe, expect, it } from "vitest";
import { LogBuffer, readLogBuffer } from "../src/task/log-buffer.ts";
import { utf8ByteLength } from "../src/task/utf8.ts";

describe("background log buffer", () => {
  it("counts UTF-8 bytes and retains a valid tail", () => {
    const buffer = LogBuffer.empty().append("stdout", "a🙂bc", 1, 6);
    expect(buffer.bytes).toBeLessThanOrEqual(6);
    expect(buffer.events[0]).toMatchObject({ text: "🙂bc", droppedBefore: true });
    expect(buffer.droppedBytes).toBe(1);
  });

  it("advances cursors and reports dropped events", () => {
    let buffer = LogBuffer.empty().append("stdout", "first\n", 1, 64);
    buffer = buffer.append("stderr", "second\n", 2, 64);
    buffer = buffer.dropOldest();
    const slice = readLogBuffer("task-1", buffer, "running", { afterCursor: 0 });
    expect(slice.events.map((event) => event.cursor)).toEqual([2]);
    expect(slice.earliestAvailableCursor).toBe(2);
    expect(slice.droppedBytes).toBe(utf8ByteLength("first\n"));
    expect(slice.nextCursor).toBe(2);
  });

  it("returns a bounded line tail when no cursor is supplied", () => {
    let buffer = LogBuffer.empty();
    buffer = buffer.append("stdout", "one\ntwo\n", 1, 1024);
    buffer = buffer.append("stdout", "three\nfour\n", 2, 1024);
    const slice = readLogBuffer("task-1", buffer, "running", { tailLines: 2 });
    expect(slice.events.map((event) => event.text).join("")).toContain("four");
    expect(slice.events.map((event) => event.text).join("")).not.toContain("one");
  });
});
