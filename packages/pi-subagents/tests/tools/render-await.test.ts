import { describe, expect, it } from "vitest";
import type { SubagentRunState } from "../../src/run/model.ts";
import { managerStateGlyph } from "pi-cosmic-ui/manager";
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

const segments = (summary: string): ReadonlyArray<string> => summary.split(" · ");

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
    expect(reportedFirst).toContain(`${managerStateGlyph("done")} run-2 reported first · retained`);
    expect(reportedFirst).not.toContain("failed first");
    // Normal settlement keeps the first-finished summary in the heading only.
    expect(reportedFirst.split(" · ").filter((part) => part.includes("first"))).toHaveLength(1);

    const failedFirst = formatAwaitSummary(
      [progressRun(1, "failed", { endedAt: 1 }), progressRun(2, "reported", { endedAt: 2 })],
      "any_finished",
      "",
      { settled: true },
    );
    expect(failedFirst).toContain(`${managerStateGlyph("failed")} run-1 failed first`);
  });

  it("keeps settled precedence for completion headings and suppresses retention marks", () => {
    const settled = formatAwaitSummary(
      [progressRun(1, "reported"), progressRun(2, "completed")],
      "all_finished",
      "",
      { settled: true },
    );
    expect(settled).toContain(`${managerStateGlyph("done")} 2/2 finished`);
    expect(settled).not.toContain("◎");
    expect(segments(settled)).not.toContain("2/2");

    const settledWithFailure = formatAwaitSummary(
      [progressRun(1, "failed"), progressRun(2, "completed")],
      "all_finished",
      "",
      { settled: true },
    );
    expect(settledWithFailure).toContain(`${managerStateGlyph("failed")} 2/2 finished`);
    expect(settledWithFailure).toContain("1 failed");

    const unsettled = formatAwaitSummary(
      [progressRun(1, "reported"), progressRun(2, "completed")],
      "all_finished",
      "",
      {},
    );
    expect(unsettled).toContain("Waiting for subagents");
    expect(unsettled).toContain("2/2");
    expect(unsettled).toContain("◎2 targets");
  });

  it("preserves interruption precedence over settled completion", () => {
    const cancelled = formatAwaitSummary([progressRun(1, "running")], "all_finished", "", {
      cancelled: true,
      settled: true,
    });
    expect(cancelled).toContain("Await canceled");

    const timedOut = formatAwaitSummary([progressRun(1, "running")], "all_finished", "", {
      timedOut: true,
    });
    expect(timedOut).toContain("Await timed out");

    const attention = formatAwaitSummary([progressRun(1, "paused")], "all_finished", "", {
      attentionRequired: true,
    });
    expect(attention).toContain("Parent action required");
  });

  it("keeps standalone counts and first-finished summaries on interrupted-settled waits", () => {
    const cancelled = formatAwaitSummary(
      [progressRun(1, "reported"), progressRun(2, "completed")],
      "all_finished",
      "",
      { cancelled: true, settled: true },
    );
    expect(cancelled).toContain("Await canceled");
    expect(cancelled).toContain("2/2");
    expect(cancelled).not.toContain("◎");

    const timedOut = formatAwaitSummary(
      [progressRun(1, "reported"), progressRun(2, "completed")],
      "all_finished",
      "",
      { timedOut: true, settled: true },
    );
    expect(timedOut).toContain("Await timed out");
    expect(timedOut).toContain("2/2");

    const attention = formatAwaitSummary(
      [progressRun(1, "paused"), progressRun(2, "completed")],
      "all_finished",
      "",
      { attentionRequired: true, settled: true },
    );
    expect(attention).toContain("Parent action required");
    expect(attention).toContain("1/2");
    expect(attention).toContain(`1 ${runStateLabel("paused")}`);

    const interruptedFirst = formatAwaitSummary(
      [progressRun(1, "failed", { endedAt: 1 }), progressRun(2, "reported", { endedAt: 2 })],
      "any_finished",
      "",
      { cancelled: true, settled: true },
    );
    expect(interruptedFirst).toContain("Await canceled");
    expect(interruptedFirst).toContain("run-1 failed first");
  });
});
