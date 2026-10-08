import { describe, expect, it } from "vitest";
import type { SubagentRunState } from "../src/run/model.ts";
import { subagentUiRefreshCadence } from "../src/ui/refresh.ts";

const states = (...values: ReadonlyArray<SubagentRunState>) => values.map((state) => ({ state }));

describe("subagent UI refresh cadence", () => {
  it("gives animation precedence over second-level clocks", () => {
    expect(subagentUiRefreshCadence(states("waiting_for_parent", "running"))).toBe(160);
    expect(
      subagentUiRefreshCadence(states("completed", "starting"), {
        includeTerminalAges: true,
      }),
    ).toBe(160);
  });

  it("refreshes live waiting and stopping durations once per second", () => {
    expect(subagentUiRefreshCadence(states("waiting_for_parent"))).toBe(1_000);
    expect(subagentUiRefreshCadence(states("stopping"))).toBe(1_000);
  });

  it("opts into paused elapsed time and terminal relative ages by render surface", () => {
    expect(subagentUiRefreshCadence(states("paused"))).toBeUndefined();
    expect(subagentUiRefreshCadence(states("paused"), { includePausedElapsed: true })).toBe(1_000);
    expect(subagentUiRefreshCadence(states("completed"))).toBeUndefined();
    expect(subagentUiRefreshCadence(states("completed"), { includeTerminalAges: true })).toBe(
      1_000,
    );
  });

  it("does not repaint static terminal states", () => {
    expect(subagentUiRefreshCadence(states("failed", "stopped"))).toBeUndefined();
    expect(subagentUiRefreshCadence([])).toBeUndefined();
  });
});
