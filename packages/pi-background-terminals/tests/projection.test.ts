import { describe, expect, it } from "vitest";
import type { BackgroundTerminalProjection } from "../src/job/model.ts";
import { footerStatus } from "../src/job/projection.ts";

const projection = (states: ReadonlyArray<"running" | "exited" | "failed">) =>
  ({
    jobs: states.map((state, index) => ({
      id: `term-${index + 1}`,
      command: "test",
      cwd: "/tmp",
      state,
      startedAt: 0,
      logCursor: 0,
      droppedLogBytes: 0,
      logs: [],
    })),
  }) satisfies BackgroundTerminalProjection;

describe("background terminal projection", () => {
  it("formats compact footer state", () => {
    expect(footerStatus(projection(["running", "running", "failed"]))).toBe(
      "2 background jobs active · 1 failed",
    );
    expect(footerStatus(projection(["failed"]))).toBe("1 background job failed");
    expect(footerStatus(projection(["exited"]))).toBeUndefined();
  });
});
