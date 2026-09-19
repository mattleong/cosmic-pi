import { describe, expect, it } from "vitest";
import type { SubagentRunState } from "../../src/run/model.ts";
import { formatAwaitSummary, type AwaitProgressRun } from "../../src/tools/render-await.ts";
import { runStateLabel } from "../../src/ui/run-state.ts";

const progressRun = (
  index: number,
  state: SubagentRunState,
  overrides: Partial<AwaitProgressRun> = {},
): AwaitProgressRun => ({
  id: `agent-${index}`,
  name: `run-${index}`,
  state,
  endedAt: state === "reported" ? index : undefined,
  ...overrides,
});

describe("await summary outcomes", () => {
  it("aggregates finished and failed counts without duplicating active states", () => {
    const summary = formatAwaitSummary(
      [
        progressRun(1, "failed"),
        progressRun(2, "reported"),
        progressRun(3, "completed"),
        progressRun(4, "stopped"),
        progressRun(5, "waiting_for_parent"),
      ],
      "all_finished",
    );
    expect(summary).toContain("4/5");
    expect(summary).toContain("1 failed");
    expect(summary).toContain(`1 ${runStateLabel("waiting_for_parent")}`);
  });

  it("summarizes the first finished target only in any-finished mode", () => {
    const reportedFirst = formatAwaitSummary(
      [progressRun(1, "failed", { endedAt: 2 }), progressRun(2, "reported", { endedAt: 1 })],
      "any_finished",
      "",
      { settled: true },
    );
    expect(reportedFirst).toContain("run-2");
    expect(reportedFirst).not.toContain("run-1");

    const failedFirst = formatAwaitSummary(
      [progressRun(1, "failed", { endedAt: 1 }), progressRun(2, "reported", { endedAt: 2 })],
      "any_finished",
      "",
      { settled: true },
    );
    expect(failedFirst).toContain("run-1");
    expect(failedFirst).not.toContain("run-2");
  });
});
