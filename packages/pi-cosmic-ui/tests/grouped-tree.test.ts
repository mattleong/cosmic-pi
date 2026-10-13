import { describe, expect, it } from "vitest";
import {
  activitySectionId,
  groupedActivityPath,
  groupedActivitySource,
  groupedActivityTree,
  type GroupedActivityRow,
} from "../src/activity/grouped-tree.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { activityRow, memberRow, withStatus } from "./support/activity.ts";

const checklist = { hideHistory: true } as const;
const entryOf = (tree: readonly GroupedActivityRow[], row: ActivityRow) =>
  tree.find((entry) => entry.id === row.key);
const sources = (tree: readonly GroupedActivityRow[]) =>
  tree.flatMap((entry) => groupedActivitySource(entry) ?? []);

describe("grouped activity projection", () => {
  it("nests owned work at any depth beneath its root owner's section", () => {
    const parent = activityRow("review");
    const found = memberRow("finder", parent);
    const verifier = memberRow("verifier", parent, "pending");
    const child = activityRow("child", "running", found.id, { kind: "command" });
    const rows = [child, verifier, found, parent];
    const tree = groupedActivityTree(rows);
    for (const row of [found, verifier]) expect(entryOf(tree, row)?.parentId).toBe(parent.key);
    expect(entryOf(tree, child)).toMatchObject({
      parentId: found.key,
      section: "subagents",
      context: [parent, found],
    });
    expect(sources(tree)).toHaveLength(rows.length);
    expect(new Set(sources(tree).map((row) => row.key)).size).toBe(rows.length);
    expect(entryOf(tree, parent)?.summary).toMatchObject({
      items: rows.length,
      running: 3,
      pending: 1,
    });
  });
  it("assigns only roots to kind sections and keeps owned work beneath its owner", () => {
    const agent = activityRow("agent");
    const task = activityRow("task", "running", agent.id, { kind: "command" });
    const owned = activityRow("owned", "needs-input", agent.id, { kind: "question" });
    const command = activityRow("command", "running", undefined, { kind: "command" });
    const orphan = activityRow("orphan", "needs-input", "missing", { kind: "question" });
    const queued = activityRow("queued", "pending", undefined, { kind: "question" });
    const tree = groupedActivityTree([agent, task, owned, command, orphan, queued]);
    const section = (row: ActivityRow) => entryOf(tree, row)?.section;
    expect([agent, task, owned, command, orphan, queued].map(section)).toEqual([
      "subagents",
      "subagents",
      "subagents",
      "tasks",
      "attention",
      "attention",
    ]);
    expect(entryOf(tree, owned)?.parentId).toBe(agent.key);
    expect(
      tree.find((entry) => entry.type === "section" && entry.section === "tasks")?.summary.items,
    ).toBe(1);
  });
  it("falls back to the member's own section when its parent row is gone", () => {
    const parent = activityRow("evicted");
    const member = memberRow("member", parent, "done");
    const task = memberRow("task", parent, "running", { kind: "command" });
    const tree = groupedActivityTree([member, task], {
      expandedHistory: new Set([member.key]),
    });
    expect(entryOf(tree, member)).toMatchObject({
      section: "subagents",
      parentId: activitySectionId("subagents"),
      context: [],
    });
    expect(entryOf(tree, task)?.section).toBe("tasks");
  });
  it("tolerates an ownership cycle without duplicate rows", () => {
    const parent = activityRow("parent", "running", "member");
    const member = memberRow("member", parent);
    const tree = groupedActivityTree([parent, member]);
    expect(sources(tree)).toHaveLength(2);
    expect(new Set(sources(tree).map((row) => row.key)).size).toBe(2);
    expect(entryOf(tree, parent)?.parentId).toBe(activitySectionId("subagents"));
  });
  it("moves a parent into history only when its row and whole subtree are finished", () => {
    const done = activityRow("parent", "done");
    const finished = memberRow("finished", done, "done");
    const variants: ReadonlyArray<readonly ActivityRow[]> = [
      [withStatus(done, "running"), finished],
      [done, memberRow("finished", done, "running")],
      [done, finished, activityRow("nested", "running", finished.id, { kind: "command" })],
      [{ ...done, awaited: true }, finished],
    ];
    for (const rows of variants) {
      const tree = groupedActivityTree(rows, checklist);
      expect(entryOf(tree, done)?.history).toBe(false);
    }
    expect(groupedActivityTree([done, finished], checklist)).toEqual([]);
    const history = groupedActivityTree([done, finished]);
    expect(entryOf(history, done)).toMatchObject({ history: true, expanded: false });
  });
  it("hides finished children of a live parent in the checklist", () => {
    const parent = activityRow("parent");
    const mapped = memberRow("mapped", parent, "done");
    const reviewing = memberRow("reviewing", parent);
    const tree = groupedActivityTree([parent, mapped, reviewing], checklist);
    expect(entryOf(tree, mapped)).toBeUndefined();
    expect(entryOf(tree, reviewing)?.parentId).toBe(parent.key);
    expect(entryOf(tree, parent)?.history).toBe(false);
  });
  it("counts queued placeholders separately from started work", () => {
    const parent = activityRow("parent");
    const rows = [
      parent,
      memberRow("queued-1", parent, "pending"),
      memberRow("queued-2", parent, "pending"),
      memberRow("starting", parent, "pending", { startedAt: 10 }),
      memberRow("running", parent),
    ];
    expect(entryOf(groupedActivityTree(rows), parent)?.summary).toMatchObject({
      items: 5,
      pending: 3,
      queued: 2,
      running: 2,
    });
  });
  it("preserves every attention source when a parent is collapsed", () => {
    const parent = activityRow("parent");
    const rows = [
      parent,
      memberRow("human", parent, "needs-input"),
      memberRow("parent-input", parent, "needs-input", { inputTarget: "parent" }),
      memberRow("blocked", parent, "blocked"),
      memberRow("failed", parent, "failed"),
    ];
    const open = entryOf(groupedActivityTree(rows), parent);
    const collapsed = entryOf(
      groupedActivityTree(rows, { collapsed: new Set([parent.key]) }),
      parent,
    );
    expect(collapsed?.summary).toEqual(open?.summary);
    expect(collapsed?.summary.attention).toEqual({ user: 1, parent: 1, blocked: 1, failed: 1 });
    expect(collapsed).toMatchObject({ expanded: false, children: 4 });
  });
  it("exposes source rows only for members and resolves presentation paths", () => {
    const parent = activityRow("parent");
    const member = memberRow("member", parent);
    const tree = groupedActivityTree([parent, member]);
    const path = groupedActivityPath(tree, member.key);
    expect(path.map((entry) => entry.type)).toEqual(["section", "member", "member"]);
    expect(path.map(groupedActivitySource)).toEqual([undefined, parent, member]);
    expect(groupedActivityTree([parent, member], { focus: parent.key }).map((e) => e.id)).toEqual([
      parent.key,
      member.key,
    ]);
  });
});
