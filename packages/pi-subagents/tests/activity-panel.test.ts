import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { SubagentProjection, SubagentRunView } from "../src/run/model.ts";
import {
  emptyActivityPresentation,
  hasSubagentActivityPanelContent,
  projectSubagentActivityPanel,
  renderSubagentActivityPanel,
  type SubagentActivityPresentationSnapshot,
} from "../src/ui/activity-panel.ts";
import { view } from "./tools/fixtures/tool-harness.ts";

// SAFETY: This fixture implements the Theme methods consumed by the panel renderer.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const projection = (runs: ReadonlyArray<SubagentRunView>): SubagentProjection => ({
  revision: 1,
  root: {
    id: "root",
    depth: 0,
    directChildCount: runs.filter((run) => !run.parentRunId || run.parentRunId === "root").length,
    descendantCount: runs.length,
  },
  runs,
});

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
) => renderSubagentActivityPanel(projection(runs), live, width, theme, 10_001);

describe("persistent subagent activity panel", () => {
  it("shows work and attention states with the ancestors needed for one hierarchy", () => {
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
    const waiting = view({
      id: "waiting",
      name: "Waiting",
      state: "waiting_for_parent",
      startedAt: 3,
    });
    const paused = view({ id: "paused", name: "Paused", state: "paused", startedAt: 4 });
    const retained = view({ id: "retained", name: "Retained", state: "reported" });
    const unrelated = view({ id: "done", name: "Unrelated done", state: "completed" });

    const panel = projectSubagentActivityPanel(
      projection([child, unrelated, retained, parent, waiting, paused]),
    );
    expect(panel.trackedRuns.map((run) => run.id)).toEqual(["child", "waiting", "paused"]);
    expect(panel.rows.map((row) => row.run.id)).toEqual(["parent", "child", "waiting", "paused"]);

    const text = render([child, unrelated, retained, parent, waiting, paused]).join("\n");
    expect(text).toContain("Parent");
    expect(text).toContain("Child");
    expect(text).toContain("waiting for reply");
    expect(text).toContain("paused");
    expect(text).toContain("1 retained");
    expect(text).not.toContain("Retained");
    expect(text).not.toContain("Unrelated done");
  });

  it("keeps siblings in launch order even when the service projection is newest-first", () => {
    const older = view({ id: "agent-r1-1", name: "Older", startedAt: 10 });
    const tiedEarlier = view({ id: "agent-r1-2", name: "Tied earlier", startedAt: 20 });
    const tiedLater = view({ id: "agent-r1-10", name: "Tied later", startedAt: 20 });

    const panel = projectSubagentActivityPanel(projection([tiedLater, tiedEarlier, older]));

    expect(panel.rows.map((row) => row.run.id)).toEqual([
      "agent-r1-1",
      "agent-r1-2",
      "agent-r1-10",
    ]);
  });

  it("renders every matching run without a row cap", () => {
    const runs = Array.from({ length: 32 }, (_, index) =>
      view({ id: `run-${index}`, name: `Run ${index}` }),
    );

    const lines = render(runs, emptyActivityPresentation(), 80);
    expect(lines).toHaveLength(33);
    expect(lines.join("\n")).toContain("Run 31");
  });

  it("marks await targets and counts finished targets without keeping terminal rows visible", () => {
    const running = view({ id: "running-target", name: "Running target" });
    const finished = view({
      id: "finished-target",
      name: "Finished target",
      state: "completed",
      endedAt: 5,
    });
    const other = view({ id: "other", name: "Other work" });
    const live = presentation({
      awaits: [
        {
          runIds: [running.id, finished.id],
          until: "all_finished",
        },
      ],
    });

    const lines = render([running, finished, other], live);
    expect(lines[0]).toContain("Subagents · 1/2");
    expect(lines.find((line) => line.includes("Running target"))).toContain("◎");
    expect(lines.find((line) => line.includes("Other work"))).not.toContain("◎");
    expect(lines.join("\n")).not.toContain("Finished target");
  });

  it("keeps wait-first mode as compact progress beside the static title", () => {
    const first = view({ id: "first", name: "First" });
    const second = view({ id: "second", name: "Second" });
    const live = presentation({
      awaits: [{ runIds: [first.id, second.id], until: "any_finished" }],
    });

    expect(render([first, second], live)[0]).toContain("Subagents · first of 2");
  });

  it("shows launch intent before the first run reaches the fleet projection", () => {
    const live = presentation({ starts: [{ requestedCount: 3 }] });
    expect(hasSubagentActivityPanelContent(projection([]), live)).toBe(true);
    expect(render([], live)).toEqual([" Subagents · 3 starting · /subagents"]);
  });

  it("keeps concurrent start intent visible in an await header", () => {
    const target = view({ id: "target", name: "Target" });
    const live = presentation({
      starts: [{ requestedCount: 2 }],
      awaits: [{ runIds: [target.id], until: "all_finished" }],
    });

    expect(render([target], live)[0]).toContain("Subagents · 0/1 · 2 starting · 1 working");
  });

  it("segments header emphasis and restores state-colored hierarchy identities", () => {
    const calls: Array<{ readonly color: string; readonly text: string }> = [];
    // SAFETY: This recording fixture implements the Theme methods consumed by the panel renderer.
    const recordingTheme = {
      fg: (color: string, text: string) => {
        calls.push({ color, text });
        return text;
      },
      bold: (text: string) => text,
    } as Theme;
    const parent = view({
      id: "parent",
      name: "Finished parent",
      state: "completed",
      endedAt: 5,
      startedAt: 1,
      profile: "planner",
    });
    const target = view({
      id: "target",
      name: "Running target",
      parentRunId: parent.id,
      startedAt: 2,
    });
    const waitingTarget = view({
      id: "waiting-target",
      name: "Waiting target",
      state: "waiting_for_parent",
      startedAt: 3,
    });
    const live = presentation({
      awaits: [{ runIds: [target.id, waitingTarget.id], until: "all_finished" }],
    });

    renderSubagentActivityPanel(
      projection([target, waitingTarget, parent]),
      live,
      120,
      recordingTheme,
      10_001,
    );

    expect(calls).toContainEqual({ color: "success", text: "Subagents" });
    expect(calls).toContainEqual({ color: "accent", text: "0/2" });
    expect(calls).toContainEqual({ color: "muted", text: "1 working" });
    expect(calls).toContainEqual({ color: "dim", text: "/subagents" });
    const railCalls = calls.filter(({ text }) => /[│├└─]/u.test(text));
    expect(railCalls.length).toBeGreaterThan(0);
    expect(railCalls.every(({ color }) => color === "success")).toBe(true);
    expect(
      calls.some(
        ({ color, text }) =>
          color === "success" && text.includes("◎") && text.includes("Running target"),
      ),
    ).toBe(true);
    expect(
      calls.some(
        ({ color, text }) =>
          color === "warning" && text.includes("◎") && text.includes("Waiting target"),
      ),
    ).toBe(true);
    expect(
      calls.some(({ color, text }) => color === "dim" && text.includes("Finished parent")),
    ).toBe(true);
    expect(calls.some(({ text }) => text === "planner")).toBe(false);
  });

  it("drops responsive metadata before clipping identity and retains narrow attention", () => {
    const running = view({
      id: "responsive",
      name: "Responsive run",
      profile: "scout",
      currentTool: "read",
    });
    const waiting = view({
      id: "waiting",
      name: "Approval",
      profile: "reviewer",
      state: "waiting_for_parent",
    });

    const narrow = render([running], emptyActivityPresentation(), 59).join("\n");
    const stacked = render([running], emptyActivityPresentation(), 60).join("\n");
    const stackedMaximum = render([running], emptyActivityPresentation(), 99).join("\n");
    const wide = render([running], emptyActivityPresentation(), 100).join("\n");
    const narrowAttention = render([waiting], emptyActivityPresentation(), 59).join("\n");

    expect(narrow).toContain("Responsive run");
    expect(narrow).not.toContain("scout");
    expect(narrow).not.toContain("read");
    expect(narrow).not.toContain("10s");
    expect(stacked).toContain("read");
    expect(stacked).toContain("10s");
    expect(stacked).not.toContain("scout");
    expect(stackedMaximum).not.toContain("scout");
    expect(wide).toContain("scout");
    expect(wide).toContain("read");
    expect(narrowAttention).toContain("waiting for reply");
    expect(narrowAttention).not.toContain("reviewer");
  });

  it("drops routine metadata before clipping long identities", () => {
    const stackedName = "s".repeat(53);
    const wideName = "w".repeat(93);
    const stacked = render(
      [
        view({
          id: "stacked-long",
          name: stackedName,
          profile: "scout",
          currentTool: "read",
        }),
      ],
      emptyActivityPresentation(),
      60,
    )[1];
    const wide = render(
      [
        view({
          id: "wide-long",
          name: wideName,
          profile: "scout",
          currentTool: "read",
        }),
      ],
      emptyActivityPresentation(),
      100,
    )[1];

    expect(stacked).toContain(stackedName);
    expect(stacked).not.toContain("read");
    expect(wide).toContain(wideName);
    expect(wide).not.toContain("scout");
    expect(wide).not.toContain("read");
  });

  it("lets glyphs carry starting and stopping state without repeated labels", () => {
    const lines = render([
      view({ id: "starting", name: "Launching", state: "starting" }),
      view({ id: "stopping", name: "Closing", state: "stopping" }),
    ]).join("\n");

    expect(lines).not.toContain("starting…");
    expect(lines).not.toContain("stopping…");
  });

  it("keeps partial cost explicit and disambiguates duplicate names", () => {
    const first = view({
      id: "agent-duplicate-one",
      name: "Same name",
      profile: "scout",
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: 0.001,
      },
    });
    const second = view({
      id: "agent-duplicate-two",
      name: "Same name",
      profile: "reviewer",
      usage: {
        input: 20,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 40,
      },
    });

    const lines = render([first, second], emptyActivityPresentation(), 160);
    expect(lines[0]).toContain("60 tok · ≥$0.001");
    expect(lines[1]).toContain("duplicate-one");
    expect(lines[2]).toContain("duplicate-two");
  });

  it.each([1, 2, 8, 20, 60, 120])(
    "sanitizes hostile labels and bounds every line at width %i",
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
      if (width > 1) expect(lines.every((line) => line.startsWith(" "))).toBe(true);
    },
  );

  it("renders nothing when only retained and terminal records remain", () => {
    const runs = [
      view({ id: "retained", state: "reported" }),
      view({ id: "complete", state: "completed" }),
      view({ id: "failed", state: "failed" }),
    ];
    expect(hasSubagentActivityPanelContent(projection(runs))).toBe(false);
    expect(render(runs)).toEqual([]);
  });
});
