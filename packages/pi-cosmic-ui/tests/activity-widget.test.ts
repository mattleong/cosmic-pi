import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  activityGlyph,
  activityWidgetSections,
  renderActivityWidget,
} from "../src/activity/widget.ts";
import { activityStatus } from "../src/activity/attention.ts";
import { activityWidgetHeight } from "../src/activity/widget-projection.ts";
import { phaseRowId, type GroupedActivityRow } from "../src/activity/grouped-tree.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { SPINNER_FRAME_MS } from "../src/manager/chrome.ts";
import { activityRow, memberRow, withStatus, workflowRow } from "./support/activity.ts";

const standalone = [
  activityRow("standalone-agent"),
  activityRow("standalone-task", "running", undefined, { kind: "command" }),
];
const workflows = Array.from({ length: 20 }, (_, index) =>
  workflowRow(`workflow-${index}`, ["Build"], "running", "Build", { title: `Workflow ${index}` }),
);
const grouped = workflows.map((workflow, index) => memberRow(`member-${index}`, workflow, "Build"));
const members = (entries: readonly GroupedActivityRow[]) =>
  entries.filter((entry) => entry.type === "member");
const expectParentsFirst = (sections: ReturnType<typeof activityWidgetSections>) => {
  const seen = new Set(sections.map((section) => section.heading.id));
  for (const entry of sections.flatMap((section) => section.entries)) {
    expect(seen.has(entry.id)).toBe(false);
    if (entry.parentId) expect(seen.has(entry.parentId)).toBe(true);
    seen.add(entry.id);
  }
};

describe("grouped activity widget", () => {
  it("shows every phase upfront with work nested beneath its named phase", () => {
    const workflow = workflowRow("workflow", ["Phase 0", "Phase 1", "Phase 2"], "running");
    const work = [0, 1, 2].map((index) => memberRow(`work-${index}`, workflow, `Phase ${index}`));
    const rows = [workflow, ...work];
    const section = activityWidgetSections(rows, 8)[0]!;
    expect(section.entries.map((entry) => entry.type)).toEqual([
      "workflow",
      "phase",
      "member",
      "phase",
      "member",
      "phase",
      "member",
    ]);
    for (const [index, row] of work.entries())
      expect(section.entries.find((entry) => entry.id === row.key)?.parentId).toBe(
        phaseRowId(workflow.key, `Phase ${index}`),
      );
    expect(section).toMatchObject({ hiddenSources: 0, hiddenPhases: 0, omittedRows: 0 });
    for (const collapsed of [
      new Set([workflow.key]),
      new Set(workflow.phases!.map((phase) => phaseRowId(workflow.key, phase.title))),
    ]) {
      const reduced = activityWidgetSections(rows, 8, { collapsed })[0]!;
      expect(reduced.entries.map((entry) => entry.type)).toEqual([
        "workflow",
        "phase",
        "phase",
        "phase",
      ]);
      expect(reduced).toMatchObject({ hiddenSources: 3, hiddenPhases: 0 });
    }
  });
  it("keeps finished, active and future phases in order while hiding finished member detail", () => {
    const workflow = workflowRow("workflow", ["Map", "Review", "Implement", "Verify"], "running");
    const done = memberRow("mapped", workflow, "Map", "done");
    const active = memberRow("reviewing", workflow, "Review");
    const section = activityWidgetSections([workflow, done, active], 8)[0]!;
    const phases = section.entries.flatMap((entry) => (entry.type === "phase" ? [entry] : []));
    expect(phases.map((entry) => [entry.title, entry.state])).toEqual([
      ["Map", "done"],
      ["Review", "running"],
      ["Implement", "pending"],
      ["Verify", "pending"],
    ]);
    expect(section.entries.some((entry) => entry.id === done.key)).toBe(false);
    expect(section.entries[0]).toMatchObject({ finishedPhases: 1 });
    expect(section).toMatchObject({ hiddenSources: 0, hiddenPhases: 0, omittedRows: 0 });
  });
  it("counts skipped phases after an early return as finished and leaves the widget when done", () => {
    const workflow = workflowRow("workflow", ["Inspect", "Fix", "Verify"], "running", "Inspect");
    const failed = memberRow("failed", workflow, "Inspect", "failed");
    const live = activityWidgetSections([workflow, failed], 8)[0]!;
    expect(live.entries[0]).toMatchObject({
      finishedPhases: 0,
      summary: { attention: { failed: 1 } },
    });
    const returned = withStatus(workflow, "done");
    expect(activityWidgetSections([returned, failed], 8)).toEqual([]);
    expect(activityWidgetHeight([returned, failed], 60)).toBe(8);
  });
  it("prioritizes the complete phase checklist over an early phase's member detail", () => {
    const workflow = workflowRow(
      "workflow",
      Array.from({ length: 5 }, (_, index) => `Phase ${index}`),
      "running",
      "Phase 0",
    );
    const work = Array.from({ length: 20 }, (_, index) =>
      memberRow(`work-${index}`, workflow, "Phase 0"),
    );
    const section = activityWidgetSections([workflow, ...work], 8)[0]!;
    expect(section.entries.filter((entry) => entry.type === "phase")).toHaveLength(5);
    expect(section).toMatchObject({ hiddenPhases: 0, hiddenSources: 19 });
    const short = activityWidgetSections([workflow], 3)[0]!;
    expect(short).toMatchObject({ hiddenPhases: 4, hiddenSources: 0, hiddenWorkflows: 0 });
  });
  it("grows for checklists within terminal bounds, without enlarging for archived workflows", () => {
    const workflow = workflowRow(
      "workflow",
      Array.from({ length: 12 }, (_, index) => `Phase ${index}`),
    );
    const rows = [workflow, ...standalone];
    const tall = activityWidgetHeight(rows, 60);
    expect(tall).toBeGreaterThan(8);
    expect(activityWidgetHeight(rows, 20)).toBeLessThanOrEqual(10);
    expect(
      activityWidgetSections(rows, tall)
        .flatMap((section) => section.entries)
        .filter((entry) => entry.type === "phase"),
    ).toHaveLength(12);
    expect(activityWidgetHeight([withStatus(workflow, "done"), ...standalone], 60)).toBe(8);
  });
  it("reserves later workflow roots and shares member rows without orphaning descendants", () => {
    const busy = workflows[0]!;
    const crowd = Array.from({ length: 10 }, (_, index) =>
      memberRow(`crowd-${index}`, busy, "Build"),
    );
    const rows = [busy, ...crowd, workflows[10]!, grouped[10]!];
    const section = activityWidgetSections(rows, 8)[0]!;
    const visible = new Set([section.heading.id, ...section.entries.map((entry) => entry.id)]);
    expect(
      section.entries.filter((entry) => entry.type === "workflow").map((entry) => entry.id),
    ).toEqual([busy.key, workflows[10]!.key]);
    expect(visible.has(crowd[0]!.key)).toBe(true);
    expect(visible.has(grouped[10]!.key)).toBe(true);
    expect(section.entries.every((entry) => !entry.parentId || visible.has(entry.parentId))).toBe(
      true,
    );
    expect(section.hiddenSources).toBe(11 - members(section.entries).length);
  });
  it("never admits nested work without its workflow, phase and owning ancestors", () => {
    const workflow = workflowRow("workflow", ["Phase 0", "Phase 1"]);
    const owner = memberRow("owner", workflow, "Phase 0");
    const child = activityRow("child", "running", owner.id);
    const task = activityRow("nested-task", "running", child.id, { kind: "command" });
    const loose = memberRow("loose", workflow);
    const other = memberRow("other", workflow, "Phase 1");
    const rows = [task, other, child, owner, loose, workflow, ...standalone];
    for (let budget = 1; budget <= 12; budget++) {
      const sections = activityWidgetSections(rows, budget);
      expectParentsFirst(sections);
      expect(renderActivityWidget(rows, 80, budget).length).toBeLessThanOrEqual(budget);
    }
    const full = activityWidgetSections(rows, 20)[0]!;
    expect(full.entries.find((entry) => entry.id === loose.key)?.parentId).toBe(workflow.key);
  });
  it("spends the full fitting budget on work rows, not category headings", () => {
    for (const count of [1, 4]) {
      const workflow = workflows[0]!;
      const work = Array.from({ length: count }, (_, index) =>
        memberRow(`work-${index}`, workflow, "Build"),
      );
      const rows = [workflow, ...work, ...standalone];
      const budget = rows.length + 1;
      const sections = activityWidgetSections(rows, budget);
      expect(sections.every((section) => section.omittedRows === 0)).toBe(true);
      const rendered = renderActivityWidget(rows, 80, budget);
      expect(rendered).toHaveLength(budget);
      for (const row of rows) expect(rendered.some((line) => line.includes(row.title))).toBe(true);
    }
  });
  it("reserves standalone agent and task rows before spending the budget on workflows", () => {
    const sections = activityWidgetSections([...workflows, ...grouped, ...standalone], 8);
    expect(sections.map((section) => section.heading.section)).toEqual([
      "workflows",
      "subagents",
      "tasks",
    ]);
    for (const row of standalone)
      expect(
        sections.flatMap((section) => section.entries).some((entry) => entry.id === row.key),
      ).toBe(true);
    expect(sections[0]!.omittedRows).toBeGreaterThan(0);
    expect(
      sections.reduce(
        (sum, section) => sum + section.entries.length + Number(section.omittedRows > 0),
        0,
      ),
    ).toBeLessThanOrEqual(8);
  });
  it("preserves running and source-specific attention counts when collapsed and clipped", () => {
    const owner = grouped[0]!;
    const human = activityRow("human", "needs-input", owner.id, { kind: "question" });
    const parent = activityRow("parent", "needs-input", owner.id, {
      kind: "question",
      inputTarget: "parent",
    });
    const rows = [...workflows, ...grouped, ...standalone, human, parent];
    for (const collapsed of [new Set<string>(), new Set([workflows[0]!.key])]) {
      const sections = activityWidgetSections(rows, 8, { collapsed });
      expect(sections[0]!.heading.summary).toMatchObject({
        running: 20,
        attention: { user: 1, parent: 1, blocked: 0, failed: 0 },
      });
      expect(sections[0]!.hiddenSources).toBeGreaterThan(0);
      const ids = sections.flatMap((section) => section.entries.map((entry) => entry.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it("keeps every attention count and omitted-work count in the rendered overview", () => {
    // Distinct counts protect visible evidence, without depending on wording, styles or layout.
    const crowd = workflowRow("crowd", ["Build"]);
    const work = [
      ...Array.from({ length: 17 }, (_, i) => memberRow(`blocked-${i}`, crowd, "Build", "blocked")),
      ...Array.from({ length: 19 }, (_, i) => memberRow(`failed-${i}`, crowd, "Build", "failed")),
    ];
    const questions = (
      [
        ["user", 11],
        ["parent", 13],
      ] as const
    ).flatMap(([inputTarget, count]) =>
      Array.from({ length: count }, (_, i) =>
        activityRow(`${inputTarget}-${i}`, "needs-input", "blocked-0", {
          kind: "question",
          inputTarget,
        }),
      ),
    );
    const rows = [crowd, ...work, ...standalone, ...questions];
    for (const [width, height] of [
      [60, 1],
      [60, 2],
      [80, 1],
      [80, 2],
      [80, 8],
    ] as const) {
      const sections = activityWidgetSections(rows, height);
      const rendered = renderActivityWidget(rows, width, height);
      expect(rendered.length).toBeLessThanOrEqual(height);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      const hidden =
        height === 8
          ? sections[0]!.hiddenSources
          : sections.reduce(
              (sum, section) => sum + section.hiddenSources + members(section.entries).length,
              0,
            );
      const evidence = [11, 13, 17, 19, hidden].map((count) => new RegExp(`\\b${count}\\b`, "u"));
      expect(
        rendered.some(
          (line) =>
            evidence.every((pattern) => pattern.test(line)) ||
            (/\b60\b/u.test(line) && new RegExp(`\\b${hidden}\\b`, "u").test(line)),
        ),
      ).toBe(true);
    }
  });
  it("animates a live workflow and renders queued work as not yet started", () => {
    const workflow = workflowRow("workflow", ["Find"], "running", "Find", { startedAt: 0 });
    const queued = memberRow("queued", workflow, "Find", "pending");
    const starting = memberRow("starting", workflow, "Find", "pending", { startedAt: 0 });
    const rows = [workflow, queued];
    expect(renderActivityWidget(rows, 100, 8, { now: 0 })).not.toEqual(
      renderActivityWidget(rows, 100, 8, { now: SPINNER_FRAME_MS }),
    );
    expect(activityGlyph(queued, 0)).toBe(activityGlyph(queued, SPINNER_FRAME_MS));
    expect(activityGlyph(starting, 0)).not.toBe(activityGlyph(starting, SPINNER_FRAME_MS));
    expect(activityStatus(queued)).not.toBe(activityStatus(starting));
  });
  it("does not hide standalone queued questions or misclassify them as tasks", () => {
    const question = activityRow("queued", "pending", undefined, { kind: "question" });
    const sections = activityWidgetSections([question]);
    expect(sections.map((section) => section.heading.section)).toEqual(["attention"]);
    expect(sections[0]?.entries.map((entry) => entry.id)).toEqual([question.key]);
  });
  it("ignores full-screen zoom and bounds every row across narrow sizes", () => {
    const question = activityRow("urgent", "needs-input", undefined, { kind: "question" });
    const rows: readonly ActivityRow[] = [...workflows, ...grouped, ...standalone, question];
    expect(
      activityWidgetSections(rows, 8, { focus: grouped[0]!.key }).map(
        (section) => section.heading.section,
      ),
    ).toEqual(["workflows", "subagents", "tasks", "attention"]);
    for (const width of [0, 1, 2, 8, 21, 40, 80, 160])
      for (const maxRows of [0, 1, 2, 4, 8]) {
        const rendered = renderActivityWidget(rows, width, maxRows);
        expect(rendered.length).toBeLessThanOrEqual(maxRows);
        for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
  });
});
