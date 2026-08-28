import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { SubagentProjection, SubagentRunView } from "../src/run/model.ts";
import {
  emptyActivityPresentation,
  hasSubagentActivityPanelContent,
  projectSubagentActivityPanel,
  renderProjectedSubagentActivityPanel,
  renderSubagentActivityPanel,
  subagentActivityPanelCadence,
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
    expect(lines[0]).toContain("Subagents · 1/2 awaited");
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
    expect(render([], live)).toEqual([" Subagents · launching 3 · /subagents"]);
  });

  it("keeps concurrent start intent visible in an await header", () => {
    const target = view({ id: "target", name: "Target" });
    const live = presentation({
      starts: [{ requestedCount: 2 }],
      awaits: [{ runIds: [target.id], until: "all_finished" }],
    });

    expect(render([target], live)[0]).toContain("Subagents · 0/1 awaited · launching 2 · 1 active");
  });

  it("summarizes overlapping await leases without flattening their wait modes", () => {
    const first = view({ id: "first", name: "First" });
    const second = view({ id: "second", name: "Second" });
    const live = presentation({
      awaits: [
        { runIds: [first.id], until: "all_finished" },
        { runIds: [first.id, second.id], until: "any_finished" },
      ],
    });

    expect(render([first, second], live, 120)[0]).toContain("2 waits · all 0/1 · first of 2");
    const compact = render([first, second], live, 35)[0] ?? "";
    expect(compact).toContain("all 0/1");
    expect(compact).toContain("/subagents");
  });

  it("keeps the title, attention, and manager command while dropping routine header data", () => {
    const target = view({
      id: "target",
      name: "Target",
      usage: {
        input: 20,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 40,
        cost: 0.001,
      },
    });
    const waiting = view({ id: "waiting", state: "waiting_for_parent" });
    const retained = view({ id: "retained", state: "reported" });
    const live = presentation({
      awaits: [{ runIds: [target.id], until: "all_finished" }],
    });

    const wide = render([target, waiting, retained], live, 120)[0] ?? "";
    expect(wide).toContain("1 active");
    expect(wide).toContain("1 waiting");
    expect(wide).toContain("1 retained");
    expect(wide).toContain("40 tok");
    expect(wide).toContain("/subagents");

    const compact = render([target, waiting, retained], live, 50)[0] ?? "";
    expect(compact).toContain("Subagents");
    expect(compact).toContain("0/1 awaited");
    expect(compact).toContain("1 waiting");
    expect(compact).toContain("/subagents");
    expect(compact).not.toContain("1 active");
    expect(compact).not.toContain("1 retained");
    expect(compact).not.toContain("40 tok");

    const attentionFirst = render([target, waiting], live, 35)[0] ?? "";
    expect(attentionFirst).toContain("1 waiting");
    expect(attentionFirst).not.toContain("awaited");
    expect(attentionFirst).toContain("/subagents");

    expect(render([target], live, 23)[0]).toBe(" Subagents · /subagents");
    expect(render([target], live, 22)[0]).toBe(" /subagents");
  });

  it("derives ticker cadence only from rows with clock-dependent presentation", () => {
    const cadence = (runs: ReadonlyArray<SubagentRunView>, live = emptyActivityPresentation()) =>
      subagentActivityPanelCadence(projectSubagentActivityPanel(projection(runs), live));

    expect(cadence([view({ state: "running" })])).toBe(160);
    expect(cadence([view({ state: "starting" })])).toBe(160);
    expect(cadence([view({ state: "waiting_for_parent" })])).toBe(1_000);
    expect(cadence([view({ state: "paused" })])).toBe(1_000);
    expect(cadence([view({ state: "stopping" })])).toBe(1_000);
    expect(cadence([view({ state: "completed" })])).toBeUndefined();
    expect(cadence([], presentation({ starts: [{ requestedCount: 2 }] }))).toBeUndefined();
    expect(
      cadence(
        [view({ id: "done", state: "completed" })],
        presentation({ awaits: [{ runIds: ["done"], until: "all_finished" }] }),
      ),
    ).toBeUndefined();
  });

  it("reuses projected structure while time-dependent rows continue to advance", () => {
    const panel = projectSubagentActivityPanel(
      projection([view({ id: "live", name: "Live", currentTool: "read", startedAt: 1 })]),
    );
    const first = renderProjectedSubagentActivityPanel(panel, 120, theme, 1_001).join("\n");
    const second = renderProjectedSubagentActivityPanel(panel, 120, theme, 2_001).join("\n");

    expect(first).toContain("1s");
    expect(second).toContain("2s");
    expect(second).not.toBe(first);
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
    expect(calls).toContainEqual({ color: "accent", text: "0/2 awaited" });
    expect(calls).toContainEqual({ color: "muted", text: "1 active" });
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
    expect(
      calls.some(({ color, text }) => color === "dim" && text.includes("planner → local/pi")),
    ).toBe(true);
  });

  it("uses profile plus a provider-free model and effort label below 100 columns", () => {
    const running = view({
      id: "responsive",
      name: "Responsive run",
      profile: "scout",
      currentTool: "read",
      fastMode: true,
    });
    const waiting = view({
      id: "waiting",
      name: "Approval",
      profile: "reviewer",
      state: "waiting_for_parent",
    });

    const veryNarrow = render([running], emptyActivityPresentation(), 40).join("\n");
    const narrow = render([running], emptyActivityPresentation(), 59).join("\n");
    const stacked = render([running], emptyActivityPresentation(), 60).join("\n");
    const stackedMaximum = render([running], emptyActivityPresentation(), 99).join("\n");
    const wide = render([running], emptyActivityPresentation(), 100).join("\n");
    const narrowAttention = render([waiting], emptyActivityPresentation(), 59).join("\n");

    for (const output of [veryNarrow, narrow, stacked, stackedMaximum]) {
      expect(output).toContain("scout · gpt-5.6-sol:high ⚡");
      expect(output).not.toContain("local/pi");
      expect(output).not.toContain("openai-codex/");
    }
    expect(wide).toContain("scout");
    expect(wide).toContain("local/pi");
    expect(wide).toContain("openai-codex/g");
    expect(narrow).toContain("Responsive run");
    expect(wide).toContain("read");
    expect(wide).toContain("10s");
    expect(narrowAttention).toContain("reviewer · gpt-5.6-sol:high");
    expect(narrowAttention).not.toContain("waiting for reply");
    expect(narrowAttention).not.toContain("local/pi");
    expect(narrowAttention).not.toContain("openai-codex/");
  });

  it("clips long identities before profile, route, and model", () => {
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

    expect(stacked).not.toContain(stackedName);
    expect(stacked).toContain("scout · gpt-5.6-sol:high");
    expect(stacked).not.toContain("local/pi");
    expect(stacked).not.toContain("openai-codex/");
    expect(stacked).not.toContain("read");
    expect(wide).not.toContain(wideName);
    expect(wide).toContain("scout local/pi openai-codex/gpt-5.6-sol:high");
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
