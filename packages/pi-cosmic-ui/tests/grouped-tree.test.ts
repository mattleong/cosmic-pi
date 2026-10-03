import { describe, expect, it } from "vitest";
import {
  activitySectionId,
  groupedActivityPath,
  groupedActivitySource,
  groupedActivityTree,
  phaseRowId,
  type GroupedActivityRow,
} from "../src/activity/grouped-tree.ts";
import { retainActivity, type ActivityRow } from "../src/activity/model.ts";
import { activityRow, memberRow, withStatus, workflowRow } from "./support/activity.ts";

const checklist = { hideHistory: true, retainPhaseHistory: true } as const;
const root = (tree: readonly GroupedActivityRow[]) =>
  tree.find((entry) => entry.type === "workflow")!;
const phases = (tree: readonly GroupedActivityRow[]) =>
  tree.flatMap((entry) => (entry.type === "phase" ? [entry] : []));
const sources = (tree: readonly GroupedActivityRow[]) =>
  tree.flatMap((entry) => groupedActivitySource(entry) ?? []);
const expandedAll = (rows: readonly ActivityRow[]) => ({
  expandedHistory: new Set(rows.map((row) => row.key)),
});

describe("grouped activity projection", () => {
  it("nests members beneath their named phase and keeps unknown or missing phases at the workflow", () => {
    const workflow = workflowRow("review", ["Find", "Verify"], "running", "Find");
    const found = memberRow("finder", workflow, "Find");
    const verifier = memberRow("verifier", workflow, "Verify", "pending");
    const loose = memberRow("loose", workflow);
    const stray = memberRow("stray", workflow, "Renamed");
    const child = activityRow("child", "running", found.id, { kind: "command" });
    const rows = [stray, child, verifier, loose, found, workflow];
    const tree = groupedActivityTree(rows);
    const find = phaseRowId(workflow.key, "Find");
    const verify = phaseRowId(workflow.key, "Verify");
    expect(phases(tree).map((entry) => entry.id)).toEqual([find, verify]);
    expect(phases(tree).every((entry) => entry.parentId === workflow.key)).toBe(true);
    expect(tree.find((entry) => entry.id === found.key)?.parentId).toBe(find);
    expect(tree.find((entry) => entry.id === verifier.key)?.parentId).toBe(verify);
    for (const row of [loose, stray])
      expect(tree.find((entry) => entry.id === row.key)?.parentId).toBe(workflow.key);
    expect(tree.find((entry) => entry.id === child.key)).toMatchObject({
      parentId: found.key,
      section: "workflows",
      context: [workflow, found],
    });
    expect(sources(tree)).toHaveLength(rows.length);
    expect(new Set(sources(tree).map((row) => row.key)).size).toBe(rows.length);
    // The workflow row is a container; its summary counts only its work.
    expect(root(tree).summary).toMatchObject({ items: rows.length - 1, running: 4, pending: 1 });
  });
  it("assigns only roots to kind sections and keeps owned work beneath its owner", () => {
    const agent = activityRow("agent");
    const task = activityRow("task", "running", agent.id, { kind: "command" });
    const owned = activityRow("owned", "needs-input", agent.id, { kind: "question" });
    const command = activityRow("command", "running", undefined, { kind: "command" });
    const orphan = activityRow("orphan", "needs-input", "missing", { kind: "question" });
    const queued = activityRow("queued", "pending", undefined, { kind: "question" });
    const workflow = workflowRow("workflow");
    const tree = groupedActivityTree([agent, task, owned, command, orphan, queued, workflow]);
    const section = (row: ActivityRow) => tree.find((entry) => entry.id === row.key)?.section;
    expect([workflow, agent, task, owned, command, orphan, queued].map(section)).toEqual([
      "workflows",
      "subagents",
      "subagents",
      "subagents",
      "tasks",
      "attention",
      "attention",
    ]);
    expect(tree.find((entry) => entry.id === owned.key)?.parentId).toBe(agent.key);
    expect(
      tree.find((entry) => entry.type === "section" && entry.section === "tasks")?.summary.items,
    ).toBe(1);
  });
  it("falls back to the member's own section when its workflow row is gone", () => {
    const workflow = workflowRow("evicted", ["Find"]);
    const member = memberRow("member", workflow, "Find", "done");
    const task = memberRow("task", workflow, "Find", "running", { kind: "command" });
    const tree = groupedActivityTree([member, task], expandedAll([member]));
    expect(tree.some((entry) => entry.type === "workflow" || entry.type === "phase")).toBe(false);
    expect(tree.find((entry) => entry.id === member.key)).toMatchObject({
      section: "subagents",
      parentId: activitySectionId("subagents"),
      context: [],
    });
    expect(tree.find((entry) => entry.id === task.key)?.section).toBe("tasks");
  });
  it("tolerates an ownership cycle through a workflow without duplicate rows", () => {
    const workflow = workflowRow("workflow", ["Find"], "running", undefined, {
      parent: { providerId: "agents", itemId: "member" },
    });
    const member = memberRow("member", workflow, "Find");
    const tree = groupedActivityTree([workflow, member]);
    expect(sources(tree)).toHaveLength(2);
    expect(new Set(sources(tree).map((row) => row.key)).size).toBe(2);
    expect(root(tree).parentId).toBe(activitySectionId("workflows"));
  });
  it.each([
    ["a running member", "running", ["running"], "Find", "running"],
    ["a waiting member", "running", ["needs-input"], undefined, "running"],
    ["finished work in the live current phase", "running", ["done"], "Find", "running"],
    ["finished work in a passed phase", "running", ["done"], "Verify", "done"],
    ["only stopped work", "running", ["cancelled", "cancelled"], "Verify", "stopped"],
    ["failed and finished work", "done", ["failed", "done"], undefined, "done"],
    ["no work before the current phase", "running", [], "Verify", "skipped"],
    ["no work in the live current phase", "running", [], "Find", "running"],
    ["no work in a future phase", "running", [], undefined, "pending"],
    ["no work after the workflow ended", "done", [], "Find", "skipped"],
    ["no work after the workflow stopped", "cancelled", [], undefined, "skipped"],
  ] as const)("derives the phase state from %s", (_name, status, members, current, expected) => {
    const workflow = workflowRow("workflow", ["Find", "Verify"], status, current);
    const rows = [
      workflow,
      ...members.map((member, index) => memberRow(`member-${index}`, workflow, "Find", member)),
    ];
    const find = phases(groupedActivityTree(rows, expandedAll(rows)))[0]!;
    expect(find.state).toBe(expected);
  });
  it.each([
    ["finished work no longer shown", { items: 20, finished: 20, stopped: 0 }, "running", "done"],
    ["only stopped work", { items: 3, finished: 3, stopped: 3 }, "done", "stopped"],
    [
      "unfinished work beyond the shown rows",
      { items: 2, finished: 1, stopped: 0 },
      "running",
      "running",
    ],
    ["no work", { items: 0, finished: 0, stopped: 0 }, "running", "skipped"],
  ] as const)(
    "derives the phase state from producer counts for %s",
    (_name, work, status, expected) => {
      const workflow = workflowRow("workflow", [], status, "Verify", {
        phases: [{ title: "Find", work }, { title: "Verify" }],
      });
      const find = phases(groupedActivityTree([workflow], expandedAll([workflow])))[0]!;
      expect(find.state).toBe(expected);
    },
  );
  it("keeps a phase that ran done after retention prunes all of its members", () => {
    const workflow = workflowRow("workflow", [], "running", "Verify", {
      phases: [
        { title: "Find", work: { items: 20, finished: 20, stopped: 0 } },
        { title: "Verify", work: { items: 131, finished: 130, stopped: 0 } },
      ],
    });
    const finished = (phase: string, count: number, endedAt: number) =>
      Array.from({ length: count }, (_, index) =>
        memberRow(`${phase}-${index}`, workflow, phase, "done", { endedAt: endedAt + index }),
      );
    const rows = retainActivity(
      [],
      [
        workflow,
        ...finished("Find", 20, 0),
        ...finished("Verify", 130, 100),
        memberRow("live", workflow, "Verify"),
      ],
    );
    expect(rows.some((row) => row.phase === "Find")).toBe(false);
    expect(
      phases(groupedActivityTree(rows, expandedAll(rows))).map((entry) => [
        entry.title,
        entry.state,
      ]),
    ).toEqual([
      ["Find", "done"],
      ["Verify", "running"],
    ]);
  });
  it("counts skipped empty phases as finished after an early return", () => {
    const workflow = workflowRow("workflow", ["One", "Two", "Three"], "done", "One", {
      startedAt: 0,
      endedAt: 1000,
    });
    const member = memberRow("member", workflow, "One", "done");
    const rows = [workflow, member];
    const archived = groupedActivityTree(rows, expandedAll(rows));
    expect(phases(archived).map((entry) => entry.state)).toEqual(["done", "skipped", "skipped"]);
    expect(root(archived)).toMatchObject({ finishedPhases: 3, history: true });
    expect(groupedActivityTree(rows, checklist)).toEqual([]);
    const live = groupedActivityTree([withStatus(workflow, "running"), member], checklist);
    expect(phases(live).map((entry) => entry.state)).toEqual(["running", "pending", "pending"]);
    expect(root(live)).toMatchObject({ finishedPhases: 0, history: false });
  });
  it("moves a workflow into history only when its row and whole subtree are finished", () => {
    const done = workflowRow("workflow", ["Find"], "done", "Find");
    const finished = memberRow("finished", done, "Find", "done");
    const variants: ReadonlyArray<readonly ActivityRow[]> = [
      [withStatus(done, "running"), finished],
      [done, memberRow("finished", done, "Find", "running")],
      [done, finished, activityRow("nested", "running", finished.id, { kind: "command" })],
      [{ ...done, awaited: true }, finished],
    ];
    for (const rows of variants) {
      const tree = groupedActivityTree(rows, checklist);
      expect(root(tree).history).toBe(false);
      expect(phases(tree)).toHaveLength(1);
    }
    expect(groupedActivityTree([done, finished], checklist)).toEqual([]);
    const history = groupedActivityTree([done, finished]);
    expect(root(history)).toMatchObject({ history: true, expanded: false, finishedPhases: 1 });
  });
  it("keeps the phase checklist while hiding finished member detail", () => {
    const workflow = workflowRow("workflow", ["Map", "Review", "Ship"], "running", "Review");
    const mapped = memberRow("mapped", workflow, "Map", "done");
    const reviewing = memberRow("reviewing", workflow, "Review");
    const tree = groupedActivityTree([workflow, mapped, reviewing], checklist);
    expect(phases(tree).map((entry) => [entry.title, entry.state, entry.history])).toEqual([
      ["Map", "done", true],
      ["Review", "running", false],
      ["Ship", "pending", false],
    ]);
    expect(tree.some((entry) => entry.id === mapped.key)).toBe(false);
    expect(tree.find((entry) => entry.id === reviewing.key)?.parentId).toBe(
      phaseRowId(workflow.key, "Review"),
    );
    expect(root(tree)).toMatchObject({ finishedPhases: 1, summary: { items: 2, terminal: 1 } });
    const withoutChecklist = groupedActivityTree([workflow, mapped, reviewing], {
      hideHistory: true,
    });
    expect(phases(withoutChecklist).map((entry) => entry.title)).toEqual(["Review", "Ship"]);
  });
  it("counts queued placeholders separately from started work", () => {
    const workflow = workflowRow("workflow", ["Find"], "running", "Find");
    const rows = [
      workflow,
      memberRow("queued-1", workflow, "Find", "pending"),
      memberRow("queued-2", workflow, "Find", "pending"),
      memberRow("starting", workflow, "Find", "pending", { startedAt: 10 }),
      memberRow("running", workflow, "Find"),
    ];
    expect(phases(groupedActivityTree(rows))[0]!.summary).toMatchObject({
      items: 4,
      pending: 3,
      queued: 2,
      running: 1,
    });
  });
  it("preserves every attention source when a workflow is collapsed", () => {
    const workflow = workflowRow("workflow", ["Find"]);
    const rows = [
      workflow,
      memberRow("human", workflow, "Find", "needs-input"),
      memberRow("parent", workflow, "Find", "needs-input", { inputTarget: "parent" }),
      memberRow("blocked", workflow, undefined, "blocked"),
      memberRow("failed", workflow, "Find", "failed"),
    ];
    const open = root(groupedActivityTree(rows));
    const collapsed = root(groupedActivityTree(rows, { collapsed: new Set([workflow.key]) }));
    expect(collapsed.summary).toEqual(open.summary);
    expect(collapsed.summary.attention).toEqual({ user: 1, parent: 1, blocked: 1, failed: 1 });
    expect(collapsed).toMatchObject({ expanded: false, children: 2 });
  });
  it("exposes source rows only for workflows and members and resolves presentation paths", () => {
    const workflow = workflowRow("workflow", ["Find"]);
    const member = memberRow("member", workflow, "Find");
    const tree = groupedActivityTree([workflow, member]);
    const path = groupedActivityPath(tree, member.key);
    expect(path.map((entry) => entry.type)).toEqual(["section", "workflow", "phase", "member"]);
    expect(path.map(groupedActivitySource)).toEqual([undefined, workflow, undefined, member]);
    const phase = phaseRowId(workflow.key, "Find");
    expect(groupedActivityTree([workflow, member], { focus: phase }).map((e) => e.id)).toEqual([
      phase,
      member.key,
    ]);
  });
});
