import { describe, expect, it } from "vitest";
import type { SubagentRunState } from "../../src/run/model.ts";
import { formatAwaitProgress, type AwaitProgressRun } from "../../src/tools/render-await.ts";
import { runStateLabel } from "../../src/ui/run-state.ts";

const progressRun = (
  index: number,
  state: SubagentRunState,
  overrides: Partial<AwaitProgressRun> = {},
): AwaitProgressRun => ({
  id: `agent-${index}`,
  name: `run-${index}`,
  state,
  endedAt: state === "completed" ? index : undefined,
  ...overrides,
});

/** The progress text's summary line; the run tree below it names every run. */
const summary = (...args: Parameters<typeof formatAwaitProgress>) =>
  formatAwaitProgress(...args).split("\n")[0];

describe("await summary outcomes", () => {
  it("aggregates finished and failed counts without duplicating active states", () => {
    const line = summary(
      [
        progressRun(1, "failed"),
        progressRun(2, "completed"),
        progressRun(3, "completed"),
        progressRun(4, "stopped"),
        progressRun(5, "waiting_for_parent"),
      ],
      "all_finished",
    );
    expect(line).toContain("4/5");
    expect(line).toContain("1 failed");
    expect(line).toContain(`1 ${runStateLabel("waiting_for_parent")}`);
  });

  it("summarizes the first finished target only in any-finished mode", () => {
    const completedFirst = summary(
      [progressRun(1, "failed", { endedAt: 2 }), progressRun(2, "completed", { endedAt: 1 })],
      "any_finished",
    );
    expect(completedFirst).toContain("run-2");
    expect(completedFirst).not.toContain("run-1");

    const failedFirst = summary(
      [progressRun(1, "failed", { endedAt: 1 }), progressRun(2, "completed", { endedAt: 2 })],
      "any_finished",
    );
    expect(failedFirst).toContain("run-1");
    expect(failedFirst).not.toContain("run-2");
    expect(summary([progressRun(1, "completed")], "all_finished")).not.toContain("run-1");
  });
});
