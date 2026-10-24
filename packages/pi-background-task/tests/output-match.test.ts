import { describe, expect, it } from "vitest";
import { LogBuffer, readLogBuffer } from "../src/task/log-buffer.ts";
import { OutputMatcher } from "../src/task/output-match.ts";

const BUDGET = 1 << 20;
const scan = (matcher: OutputMatcher, buffer: LogBuffer) =>
  matcher.match(
    readLogBuffer("task-0000000001", buffer, "running", { afterCursor: matcher.afterCursor }),
  );

describe("output matcher", () => {
  it("leaves out the gap before the retained output it started at, even once evicted", () => {
    const buffer = new LogBuffer().append("stdout", "old\n", 0, BUDGET);
    buffer.dropOldest();
    buffer
      .addDropped(40)
      .append("stdout", "kept\n", 1, BUDGET)
      .append("stdout", "next\n", 2, BUDGET);
    // A wait without a cursor starts at the oldest retained output, after the gap before it.
    const matcher = new OutputMatcher(["absent"], {
      afterCursor: buffer.earliestCursor,
      ignoredGapBytes: buffer.oldestEvent?.droppedBefore ?? 0,
    });
    // Eviction passes the start before the first scan, so only the evicted text was missed.
    buffer.dropOldest();
    expect(scan(matcher, buffer)).toBeUndefined();
    expect(matcher.skipped).toEqual({ bytes: 5 });

    buffer.addDropped(9).append("stdout", "more\n", 3, BUDGET);
    expect(scan(matcher, buffer)).toBeUndefined();
    expect(matcher.skipped).toEqual({ bytes: 14 });
  });
});
