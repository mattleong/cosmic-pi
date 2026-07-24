import { describe, expect, it } from "vitest";
import {
  appendLog,
  dropOldestLogEvent,
  emptyLogBuffer,
  readLogBuffer,
  utf8ByteLength,
} from "../src/job/log-buffer.ts";

describe("background log buffer", () => {
  it("counts UTF-8 bytes and retains a valid tail", () => {
    const buffer = appendLog(emptyLogBuffer(), "stdout", "a🙂bc", 1, 6);
    expect(buffer.bytes).toBeLessThanOrEqual(6);
    expect(buffer.events[0]?.text).toBe("🙂bc");
    expect(buffer.droppedBytes).toBe(1);
  });

  it("advances cursors and reports dropped events", () => {
    let buffer = appendLog(emptyLogBuffer(), "stdout", "first\n", 1, 64);
    buffer = appendLog(buffer, "stderr", "second\n", 2, 64);
    buffer = dropOldestLogEvent(buffer);
    const slice = readLogBuffer("term-1", buffer, "running", { afterCursor: 0 });
    expect(slice.events.map((event) => event.cursor)).toEqual([2]);
    expect(slice.earliestAvailableCursor).toBe(2);
    expect(slice.droppedBytes).toBe(utf8ByteLength("first\n"));
    expect(slice.nextCursor).toBe(2);
  });

  it("returns a bounded line tail when no cursor is supplied", () => {
    let buffer = emptyLogBuffer();
    buffer = appendLog(buffer, "stdout", "one\ntwo\n", 1, 1024);
    buffer = appendLog(buffer, "stdout", "three\nfour\n", 2, 1024);
    const slice = readLogBuffer("term-1", buffer, "running", { tailLines: 2 });
    expect(slice.events.map((event) => event.text).join("")).toContain("four");
    expect(slice.events.map((event) => event.text).join("")).not.toContain("one");
  });
});
