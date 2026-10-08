import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { activityStatus } from "../src/activity/attention.ts";
import {
  groupedActivityTree,
  phaseRowId,
  type GroupedActivityRow,
} from "../src/activity/grouped-tree.ts";
import {
  COMPLETED_BRANCH_LIMIT,
  isFinished,
  retainActivity,
  type ActivityRow,
} from "../src/activity/model.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityMark } from "../src/activity/row-line.ts";
import { activityWidgetHeight, activityWidgetSections } from "../src/activity/widget-projection.ts";
import { SPINNER_FRAME_MS } from "../src/manager/chrome.ts";
import {
  groupedDetailOf,
  memberRow,
  mountActivity,
  withStatus,
  workflowRow,
} from "./support/activity.ts";

/** A declared agent its workflow hasn't called; a finished workflow never will. */
const planned = (
  id: string,
  workflow: ActivityRow,
  phase?: string,
  overrides: Partial<ActivityRow> = {},
): ActivityRow =>
  memberRow(id, workflow, phase, isFinished(workflow) ? "cancelled" : "pending", {
    planned: true,
    ...overrides,
  });
const phases = (tree: readonly GroupedActivityRow[]) =>
  tree.flatMap((entry) => (entry.type === "phase" ? [entry] : []));
const count = (value: number) => new RegExp(`\\b${value}\\b`, "u");
const entryOf = <Type extends GroupedActivityRow["type"]>(
  tree: readonly GroupedActivityRow[],
  type: Type,
  title?: string,
) =>
  tree.find(
    (entry): entry is Extract<GroupedActivityRow, { readonly type: Type }> =>
      entry.type === type && (title === undefined || entry.title === title),
  );

describe("planned workflow agents", () => {
  it("counts planned agents apart from work, so they never move a phase or the workflow", () => {
    const workflow = workflowRow("audit", ["Map", "Review", "Verify"], "running", "Map");
    const rows = [
      workflow,
      memberRow("mapper", workflow, "Map"),
      planned("review-1", workflow, "Review"),
      planned("review-2", workflow, "Review"),
      planned("verify-1", workflow, "Verify"),
    ];
    const live = groupedActivityTree(rows);
    expect(phases(live).map((entry) => entry.state)).toEqual(["running", "pending", "pending"]);
    expect(phases(live)[1]!.summary).toMatchObject({
      items: 0,
      pending: 0,
      queued: 0,
      planned: 2,
      unrun: 0,
    });
    expect(live.find((entry) => entry.type === "workflow")).toMatchObject({
      phaseCounts: { done: 0 },
      history: false,
      summary: { items: 1, running: 1, planned: 3 },
    });
    // The workflow ends: what it planned and never called reads as not run, not stopped work.
    const ended = withStatus(workflow, "done");
    const finished = [
      ended,
      memberRow("mapper", ended, "Map", "done"),
      planned("review-1", ended, "Review"),
      planned("verify-1", ended, "Verify"),
    ];
    const archived = groupedActivityTree(finished, {
      expandedHistory: new Set(finished.map((row) => row.key)),
    });
    expect(phases(archived).map((entry) => entry.state)).toEqual(["done", "skipped", "skipped"]);
    expect(archived.find((entry) => entry.type === "workflow")).toMatchObject({
      history: true,
      summary: { items: 1, terminal: 1, stopped: 0, planned: 0, unrun: 2 },
    });
    expect(groupedActivityTree(finished, { hideHistory: true })).toEqual([]);
  });

  it("lists every real member of a phase before its planned agents", () => {
    const workflow = workflowRow("audit", ["Review"], "running", "Review");
    const rows = [
      workflow,
      planned("planned", workflow, "Review"),
      memberRow("queued", workflow, "Review", "pending"),
      memberRow("running", workflow, "Review"),
    ];
    const members = groupedActivityTree(rows)
      .filter((entry) => entry.parentId === phaseRowId(workflow.key, "Review"))
      .map((entry) => entry.id);
    expect(members.at(-1)).toBe(rows[1]!.key);
    expect(new Set(members)).toEqual(new Set(rows.slice(1).map((row) => row.key)));
  });

  it("lists a live phase's finished work before its planned agents, and never-run agents last", () => {
    const workflow = workflowRow("audit", ["Review"], "running", "Review");
    const rows = [
      workflow,
      planned("planned", workflow, "Review"),
      memberRow("done", workflow, "Review", "done"),
      memberRow("running", workflow, "Review"),
    ];
    const phase = phaseRowId(workflow.key, "Review");
    const order = (values: readonly ActivityRow[]) =>
      groupedActivityTree(values, {
        expandedHistory: new Set([phase, ...values.map((row) => row.key)]),
      })
        .filter((entry) => entry.parentId === phase)
        .map((entry) => entry.title);
    // The manager keeps finished members in view: live work, then finished work, then the plan.
    expect(order(rows)).toEqual(["running", "done", "planned"]);
    const ended = withStatus(workflow, "done");
    expect(
      order([
        ended,
        planned("unrun", ended, "Review"),
        memberRow("stopped", ended, "Review", "cancelled"),
        memberRow("done", ended, "Review", "done"),
      ]),
    ).toEqual(["stopped", "done", "unrun"]);
  });

  it("counts the producer's planned agents at every level, including rows it doesn't publish", () => {
    const workflow = workflowRow("audit", [], "running", "Map", {
      phases: [
        { title: "Map", planned: 1 },
        { title: "Review", planned: 100 },
      ],
    });
    const rows = [
      workflow,
      memberRow("mapper", workflow, "Map"),
      planned("map-1", workflow, "Map"),
      ...[1, 2, 3].map((index) => planned(`review-${index}`, workflow, "Review")),
    ];
    const live = groupedActivityTree(rows);
    expect(entryOf(live, "phase", "Review")?.summary.planned).toBe(100);
    // The workflow detail and the manager's section heading agree with the phase rows.
    expect(entryOf(live, "workflow")?.summary).toMatchObject({ planned: 101, unrun: 0 });
    expect(entryOf(live, "section")?.summary).toMatchObject({ planned: 101, unrun: 0 });
    const ended = withStatus(workflow, "done");
    const finished = [
      ended,
      memberRow("mapper", ended, "Map", "done"),
      ...[1, 2, 3].map((index) => planned(`review-${index}`, ended, "Review")),
    ];
    const archived = groupedActivityTree(finished, {
      expandedHistory: new Set(finished.map((row) => row.key)),
    });
    expect(entryOf(archived, "workflow")?.summary).toMatchObject({ planned: 0, unrun: 101 });
    expect(entryOf(archived, "section")?.summary).toMatchObject({ planned: 0, unrun: 101 });
  });

  it("counts planned agents outside the shown phases on the workflow, once", () => {
    const workflow = workflowRow("audit", [], "running", "P1", {
      phases: [
        { title: "P1", planned: 2 },
        { title: "P2", planned: 2 },
      ],
      // Planned agents in phases the producer doesn't show, some of them published as rows.
      unphasedPlanned: 16,
    });
    const rows = [
      workflow,
      planned("p1", workflow, "P1"),
      ...[1, 2].map((index) => planned(`later-${index}`, workflow)),
    ];
    const live = entryOf(groupedActivityTree(rows), "workflow");
    expect(live?.unphased).toEqual({ planned: 16, unrun: 0 });
    expect(live?.summary).toMatchObject({ planned: 20, unrun: 0 });
    // The persistent view counts them on the workflow row, since no phase row does.
    expect(renderActivityWidget(rows, 120, 20)[0]).toMatch(count(16));
    // Without a producer count, the visible rows outside any phase are counted instead.
    const { unphasedPlanned: _, ...uncounted } = workflow;
    const visible = entryOf(groupedActivityTree([uncounted, ...rows.slice(1)]), "workflow");
    expect(visible?.unphased).toEqual({ planned: 2, unrun: 0 });
    expect(visible?.summary.planned).toBe(6);
    const ended = withStatus(workflow, "cancelled");
    expect(entryOf(groupedActivityTree([ended]), "workflow")?.summary).toMatchObject({
      planned: 0,
      unrun: 20,
    });
  });

  it("keeps a passed phase with planned agents pending while the workflow can still call them", () => {
    const workflow = workflowRow("audit", ["Map", "Review", "Verify"], "running", "Verify", {
      phases: [{ title: "Map", planned: 1 }, { title: "Review" }, { title: "Verify" }],
    });
    const rows = [
      workflow,
      planned("m1", workflow, "Map"),
      memberRow("reviewer", workflow, "Review", "done"),
      memberRow("verifier", workflow, "Verify"),
    ];
    const tree = groupedActivityTree(rows);
    expect(phases(tree).map((entry) => entry.state)).toEqual(["pending", "done", "running"]);
    expect(entryOf(tree, "workflow")?.phaseCounts).toMatchObject({ done: 1, pending: 1 });
    // It stays open in the manager, with its planned agent in view.
    expect(entryOf(tree, "phase", "Map")).toMatchObject({ history: false, expanded: true });
    expect(tree.some((entry) => entry.id === rows[1]!.key)).toBe(true);
    // Once the workflow ends, nothing can call it, and the phase was skipped.
    const ended = withStatus(workflow, "done");
    const archived = groupedActivityTree(
      [
        ended,
        planned("m1", ended, "Map"),
        memberRow("reviewer", ended, "Review", "done"),
        memberRow("verifier", ended, "Verify", "done"),
      ],
      { expandedHistory: new Set([ended.key]) },
    );
    expect(phases(archived).map((entry) => entry.state)).toEqual(["skipped", "done", "done"]);
  });

  it("keeps a passed phase whose work was stopped as stopped, though planned agents remain", () => {
    const workflow = workflowRow("audit", ["Map", "Review"], "running", "Review", {
      phases: [
        { title: "Map", work: { items: 1, finished: 1, stopped: 1 }, planned: 1 },
        { title: "Review" },
      ],
    });
    const rows = [
      workflow,
      // The user stopped the mapper while it ran; the phase never called its second agent.
      memberRow("mapper", workflow, "Map", "cancelled", { startedAt: 1, endedAt: 2 }),
      planned("map-2", workflow, "Map"),
      memberRow("reviewer", workflow, "Review"),
    ];
    const tree = groupedActivityTree(rows);
    expect(phases(tree).map((entry) => entry.state)).toEqual(["stopped", "running"]);
    expect(entryOf(tree, "workflow")?.phaseCounts).toMatchObject({ stopped: 1, pending: 0 });
  });

  it("retains real results before never-run agents and doesn't report those as hidden items", () => {
    const workflow = workflowRow("audit", [], "done", undefined, {
      phases: [{ title: "Verify", planned: 20 }],
      endedAt: 10_000,
    });
    const done = Array.from({ length: 120 }, (_, index) =>
      memberRow(`done-${index}`, workflow, "Verify", "done", { endedAt: index + 1 }),
    );
    // Never-run agents end with their workflow, after all of its real work.
    const unrun = Array.from({ length: 20 }, (_, index) =>
      planned(`unrun-${index}`, workflow, "Verify", { endedAt: 10_000 }),
    );
    const retained = retainActivity([], [workflow, ...done, ...unrun]);
    expect(retained.length).toBe(COMPLETED_BRANCH_LIMIT);
    expect(retained.filter((row) => row.planned !== true && row.kind === "agent")).toHaveLength(
      120,
    );
    expect(retained.find((row) => row.key === workflow.key)?.omittedChildren).toBeUndefined();
    // The phase, the workflow and its section all still count every never-run agent.
    const tree = groupedActivityTree(retained, { expandedHistory: new Set([workflow.key]) });
    for (const entry of [
      entryOf(tree, "phase", "Verify"),
      entryOf(tree, "workflow"),
      entryOf(tree, "section"),
    ])
      expect(entry?.summary.unrun).toBe(20);
  });

  it("renders planned agents statically and apart from queued and never-run work", () => {
    const workflow = workflowRow("audit", ["Review"], "running", "Review");
    const plan = planned("planned", workflow, "Review");
    const queued = memberRow("queued", workflow, "Review", "pending");
    const unrun = planned("unrun", withStatus(workflow, "done"), "Review");
    expect(activityMark(plan, 0)).toEqual(activityMark(plan, SPINNER_FRAME_MS));
    const statuses = [plan, queued, unrun].map(activityStatus);
    expect(new Set(statuses).size).toBe(3);
  });

  it("keeps the manager's selection when the script calls a planned agent", () => {
    const workflow = workflowRow("audit", ["Review"], "running", "Review");
    const plan = planned("agent-1", workflow, "Review");
    let rows: readonly ActivityRow[] = [workflow, plan];
    const { component } = mountActivity(() => rows);
    component.render(120);
    for (let step = 0; step < 8 && component.shell.state.selectedId !== plan.key; step++)
      component.handleInput("j");
    expect(component.shell.state.selectedId).toBe(plan.key);
    // The reserved id carries the row from planned to queued to running.
    rows = [workflow, memberRow("agent-1", workflow, "Review", "pending")];
    component.update();
    component.render(120);
    expect(component.shell.state.selectedId).toBe(plan.key);
    rows = [workflow, memberRow("agent-1", workflow, "Review", "running", { startedAt: 1 })];
    component.update();
    component.render(120);
    expect(component.shell.state.selectedId).toBe(plan.key);
  });

  it("admits planned rows only after real work and counts those that don't fit", () => {
    const titles = ["Inventory", "Audit", "Fix", "Verify"];
    const workflow = workflowRow("harden", titles, "running", "Inventory", {
      // The producer also planned agents it doesn't publish as rows.
      phases: titles.map((title) => ({ title, ...(title === "Verify" && { planned: 9 }) })),
    });
    const work = ["one", "two"].map((id) => memberRow(id, workflow, "Inventory"));
    const plan = ["Audit", "Fix", "Verify"].flatMap((phase) =>
      Array.from({ length: 5 }, (_, index) => planned(`${phase}-${index}`, workflow, phase)),
    );
    const rows = [workflow, ...plan, ...work];
    for (let budget = 1; budget <= 24; budget++) {
      const [section] = activityWidgetSections(rows, budget);
      const shown = new Set(section!.entries.map((entry) => entry.id));
      const plannedShown = plan.filter((row) => shown.has(row.key)).length;
      if (plannedShown > 0) for (const row of work) expect(shown.has(row.key)).toBe(true);
      expect(section!.hiddenPlanned).toBe(plan.length - plannedShown);
      expect(section!.hiddenSources).toBe(work.filter((row) => !shown.has(row.key)).length);
    }
    const rendered = renderActivityWidget(rows, 80, 10);
    // Each phase row keeps its planned count, the producer's own when it sends one.
    expect(rendered.find((line) => line.includes("Audit"))).toMatch(count(5));
    expect(rendered.find((line) => line.includes("Verify"))).toMatch(count(9));
    const [section] = activityWidgetSections(rows, 10);
    expect(rendered.at(-1)).toMatch(count(section!.hiddenPlanned));
  });

  it("grows the widget for planned agents within the terminal bounds", () => {
    const workflow = workflowRow("audit", ["Review"], "running", "Review");
    const plan = Array.from({ length: 12 }, (_, index) =>
      planned(`plan-${index}`, workflow, "Review"),
    );
    expect(activityWidgetHeight([workflow, ...plan], 60)).toBeGreaterThan(
      activityWidgetHeight([workflow], 60),
    );
    expect(activityWidgetHeight([workflow, ...plan], 20)).toBeLessThanOrEqual(10);
    const tall = activityWidgetHeight([workflow, ...plan], 60);
    expect(activityWidgetSections([workflow, ...plan], tall)[0]!.hiddenPlanned).toBe(0);
  });

  it("shows the producer's planned count in phase detail", () => {
    const workflow = workflowRow("audit", [], "running", "Map", {
      phases: [{ title: "Map" }, { title: "Review", planned: 7 }],
    });
    const rows = [workflow, planned("review-1", workflow, "Review")];
    const text = groupedDetailOf(
      rows,
      (entry) => entry.type === "phase" && entry.title === "Review",
    );
    expect(text).toMatch(count(7));
  });
});

describe("workflow narrator line", () => {
  const narrated = (summary: string | undefined) =>
    workflowRow("audit", ["Map", "Review"], "running", "Map", {
      title: "Audit",
      ...(summary !== undefined && { summary }),
    });

  it("shows the latest summary beneath its workflow row when space allows", () => {
    const workflow = narrated("Mapping the checkout flow");
    const rows = [workflow, memberRow("mapper", workflow, "Map")];
    const rendered = renderActivityWidget(rows, 80, 8);
    expect(rendered[0]).toContain("Audit");
    expect(rendered[1]).toContain("Mapping the checkout flow");
    for (const empty of [undefined, "", "   "]) {
      const quiet = narrated(empty);
      const lines = renderActivityWidget([quiet, memberRow("mapper", quiet, "Map")], 80, 8);
      expect(lines).toHaveLength(4);
    }
  });

  it("grows the widget for its narrator line", () => {
    const titles = Array.from({ length: 6 }, (_, index) => `Phase ${index}`);
    const workflow = (summary?: string) =>
      workflowRow("audit", titles, "running", titles[0], summary ? { summary } : {});
    expect(activityWidgetHeight([workflow("Mapping the checkout flow")], 60)).toBeGreaterThan(
      activityWidgetHeight([workflow()], 60),
    );
  });

  it("yields to the phase checklist when space is tight and stays within the width", () => {
    const workflow = narrated(`Reviewing ${"every call site ".repeat(20)}`);
    const rows = [workflow, memberRow("mapper", workflow, "Map")];
    // Workflow and phase rows come first; the narrator never displaces them.
    const tight = renderActivityWidget(rows, 80, 4);
    expect(tight.some((line) => line.includes("Reviewing"))).toBe(false);
    expect(tight.filter((line) => line.includes("Map") || line.includes("Review"))).toHaveLength(2);
    for (const width of [20, 40, 80])
      for (const line of renderActivityWidget(rows, width, 8))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    // Only the widget renders it as a line; the manager keeps it in the workflow detail.
    const text = groupedDetailOf(rows, (entry) => entry.type === "workflow");
    expect(text).toContain("Reviewing every call site");
  });
});
