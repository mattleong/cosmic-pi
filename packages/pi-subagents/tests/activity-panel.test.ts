import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  emptyActivityPresentation,
  hasSubagentActivityPanelContent,
  projectSubagentActivityPanel,
  renderProjectedSubagentActivityPanel,
  subagentActivityPanelCadence,
  type SubagentActivityPresentationSnapshot,
} from "../src/ui/activity-panel.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";

const presentation = (
  overrides: Partial<SubagentActivityPresentationSnapshot> = {},
): SubagentActivityPresentationSnapshot => ({
  revision: 1,
  starts: [],
  awaits: [],
  ...overrides,
});

const render = (
  runs: ReadonlyArray<SubagentRunView>,
  live = emptyActivityPresentation(),
  width = 120,
) =>
  renderProjectedSubagentActivityPanel(
    projectSubagentActivityPanel(projectionOf(runs), live),
    width,
    plainTheme,
    10_001,
  );

describe("persistent subagent activity panel", () => {
  it("tracks work and attention states with the ancestors needed for one hierarchy", () => {
    const parent = view({
      id: "parent",
      name: "Parent",
      state: "completed",
      endedAt: 5,
      parentRunId: "root",
      startedAt: 1,
    });
    const child = view({
      id: "child",
      name: "Child",
      parentRunId: parent.id,
      depth: 2,
      state: "running",
      startedAt: 2,
    });
    const waiting = view({ id: "waiting", state: "waiting_for_parent", startedAt: 3 });
    const paused = view({ id: "paused", state: "paused", startedAt: 4 });
    const retained = view({ id: "retained", state: "reported" });
    const unrelated = view({ id: "done", state: "completed" });

    const panel = projectSubagentActivityPanel(
      projectionOf([child, unrelated, retained, parent, waiting, paused]),
    );

    expect(panel.trackedRuns.map((run) => run.id)).toEqual(["child", "waiting", "paused"]);
    expect(panel.rows.map((row) => row.run.id)).toEqual(["parent", "child", "waiting", "paused"]);
    expect(panel.retainedCount).toBe(1);
  });

  it("keeps siblings in launch order even when the service projection is newest-first", () => {
    const older = view({ id: "agent-r1-1", startedAt: 10 });
    const tiedEarlier = view({ id: "agent-r1-2", startedAt: 20 });
    const tiedLater = view({ id: "agent-r1-10", startedAt: 20 });

    const panel = projectSubagentActivityPanel(projectionOf([tiedLater, tiedEarlier, older]));

    expect(panel.rows.map((row) => row.run.id)).toEqual([
      "agent-r1-1",
      "agent-r1-2",
      "agent-r1-10",
    ]);
  });

  it("does not cap matching runs", () => {
    const runs = Array.from({ length: 32 }, (_, index) => view({ id: `run-${index}` }));
    const panel = projectSubagentActivityPanel(projectionOf(runs));

    expect(panel.trackedRuns).toHaveLength(runs.length);
    expect(panel.rows).toHaveLength(runs.length);
  });

  it("projects overlapping await leases without losing their modes or terminal targets", () => {
    const running = view({ id: "running-target" });
    const finished = view({ id: "finished-target", state: "completed", endedAt: 5 });
    const other = view({ id: "other" });
    const live = presentation({
      awaits: [
        { runIds: [running.id, finished.id], until: "all_finished" },
        { runIds: [running.id, other.id], until: "any_finished" },
      ],
    });

    const panel = projectSubagentActivityPanel(projectionOf([running, finished, other]), live);

    expect([...panel.awaitedRunIds]).toEqual([running.id, finished.id, other.id]);
    expect(panel.awaitedRuns.map((run) => run.id)).toEqual([running.id, finished.id, other.id]);
    expect(panel.presentation.awaits.map((entry) => entry.until)).toEqual([
      "all_finished",
      "any_finished",
    ]);
    expect(panel.rows.map((row) => row.run.id)).not.toContain(finished.id);
  });

  it("keeps launch intent visible before the fleet projection catches up", () => {
    const live = presentation({ starts: [{ requestedCount: 3 }] });
    expect(hasSubagentActivityPanelContent(projectionOf([]), live)).toBe(true);
  });

  it("derives ticker cadence only from rows with clock-dependent presentation", () => {
    const cadence = (runs: ReadonlyArray<SubagentRunView>, live = emptyActivityPresentation()) =>
      subagentActivityPanelCadence(projectSubagentActivityPanel(projectionOf(runs), live));

    // The base state mapping is covered with subagentUiRefreshCadence; the panel adds paused elapsed.
    expect(cadence([view({ state: "paused" })])).toBe(1_000);
    expect(cadence([], presentation({ starts: [{ requestedCount: 2 }] }))).toBeUndefined();
    expect(
      cadence(
        [view({ id: "done", state: "completed" })],
        presentation({ awaits: [{ runIds: ["done"], until: "all_finished" }] }),
      ),
    ).toBeUndefined();
  });

  it.each([1, 2, 8, 20, 60, 120])(
    "sanitizes hostile values and bounds every rendered line at width %i",
    (width) => {
      const hostile = view({
        id: "hostile",
        name: "bad\nname\u001b]8;;https://example.com\u0007link",
        profile: "scout",
        currentTool: "read\rtool\u001b[31msecret",
      });
      const lines = render([hostile], emptyActivityPresentation(), width);

      expect(
        lines.every(
          (line) =>
            !line.includes("\n") && !line.includes("https://example.com") && !line.includes("[31m"),
        ),
      ).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    },
  );

  it("renders nothing when only retained and terminal records remain", () => {
    const runs = [
      view({ id: "retained", state: "reported" }),
      view({ id: "complete", state: "completed" }),
      view({ id: "failed", state: "failed" }),
    ];
    expect(hasSubagentActivityPanelContent(projectionOf(runs))).toBe(false);
    expect(render(runs)).toEqual([]);
  });
});
