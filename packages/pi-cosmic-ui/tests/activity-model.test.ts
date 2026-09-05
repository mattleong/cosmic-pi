import { describe, expect, it } from "vitest";
import { activityKey, type ActivityItem } from "../src/activity/protocol.ts";
import { retainActivity, type ActivityRow } from "../src/activity/model.ts";
import { activityPath, activityTree, needsYou } from "../src/activity/tree.ts";
const row = (
  id: string,
  status: ActivityItem["status"] = "running",
  parent?: string,
): ActivityRow => {
  const value: ActivityRow = {
    key: activityKey("agents", id),
    id,
    title: id,
    kind: "agent",
    status,
    providerId: "agents",
    generation: 1,
    revision: "1",
  };
  if (parent) Object.assign(value, { parent: { providerId: "agents", itemId: parent } });
  return value;
};
describe("activity ownership", () => {
  it("keeps an explicitly awaited finished run visible only while its lease remains live", () => {
    const awaited = { ...row("finished", "done"), awaited: true };
    expect(activityTree([awaited])[0]?.history).toBe(false);
    const released = { ...awaited, awaited: false };
    expect(activityTree([released])[0]?.history).toBe(true);
    const retained = retainActivity([awaited], []);
    expect(retained[0]?.awaited).toBe(false);
    expect(activityTree(retained)[0]?.history).toBe(true);
  });
  it("summarizes hidden descendant problems without counting the parent twice", () => {
    const values = [
      row("root", "needs-input"),
      row("branch", "running", "root"),
      row("question", "needs-input", "branch"),
      row("blocked", "blocked", "branch"),
      row("failed", "failed", "root"),
      row("unrelated", "failed"),
    ];
    const tree = activityTree(values, { collapsed: new Set([values[0]!.key]) });
    expect(tree.find((entry) => entry.row.id === "root")?.attention).toEqual({
      waiting: 1,
      blocked: 1,
      failed: 1,
    });
    expect(tree.some((entry) => entry.row.id === "question")).toBe(false);
    const focused = activityTree(values, { focus: values[1]!.key });
    expect(focused[0]?.attention).toEqual({ waiting: 1, blocked: 1, failed: 0 });
  });
  it("preserves sibling ancestry across collapse, history ordering, and branch focus", () => {
    const values = [
      row("finished", "done"),
      row("root"),
      row("first", "running", "root"),
      row("grandchild", "running", "first"),
      row("last", "running", "root"),
    ];
    const tree = activityTree(values);
    expect(tree.map((entry) => [entry.row.id, entry.continuations])).toEqual([
      ["root", []],
      ["first", [true]],
      ["grandchild", [true, false]],
      ["last", [false]],
      ["finished", []],
    ]);
    const collapsed = activityTree(values, { collapsed: new Set([values[2]!.key]) });
    expect(collapsed.find((entry) => entry.row.id === "first")).toMatchObject({
      expanded: false,
      children: 1,
      continuations: [true],
    });
    expect(collapsed.some((entry) => entry.row.id === "grandchild")).toBe(false);
    const focused = activityTree(values, { focus: values[2]!.key });
    expect(focused.map((entry) => entry.continuations)).toEqual([[], [false]]);
    expect(activityPath(values, values[3]!.key).map((entry) => entry.id)).toEqual([
      "root",
      "first",
      "grandchild",
    ]);
  });
  it("uses the same qualified ownership for breadcrumbs and the visible tree", () => {
    const parent = row("same");
    const child: ActivityRow = {
      ...row("same"),
      key: activityKey("questions", "same"),
      providerId: "questions",
      kind: "question",
      parent: { providerId: "agents", itemId: "same" },
    };
    expect(activityPath([parent, child], child.key).map((entry) => entry.key)).toEqual([
      parent.key,
      child.key,
    ]);
    expect(activityPath([child], child.key)).toEqual([child]);
    const cyclic = [
      row("a", "running", "b"),
      row("b", "running", "a"),
      row("child", "running", "a"),
    ];
    for (const entry of activityTree(cyclic)) {
      expect(entry.depth).toBe(0);
      expect(activityPath(cyclic, entry.row.key)).toEqual([entry.row]);
    }
  });
  it("keeps only explicit ownership and tolerates missing or cyclic parents", () => {
    const values = [
      row("child", "running", "root"),
      row("standalone"),
      row("root"),
      row("orphan", "running", "missing"),
      row("a", "running", "b"),
      row("b", "running", "a"),
    ];
    const tree = activityTree(values);
    expect(tree.find((entry) => entry.row.id === "child")?.depth).toBe(1);
    expect(tree.filter((entry) => entry.depth === 0).map((entry) => entry.row.id)).toEqual([
      "standalone",
      "root",
      "orphan",
      "a",
      "b",
    ]);
    expect(new Set(tree.map((entry) => entry.row.key)).size).toBe(values.length);
  });
  it("retains completed descendants under an active owner without retaining their actions", () => {
    const root = row("root");
    const child = { ...row("child", "done", "root"), actions: [{ id: "open", label: "Open" }] };
    const retained = retainActivity([root, child], [root]);
    expect(retained.map((entry) => entry.id)).toEqual(["root", "child"]);
    expect(retained[1]?.actions).toEqual([]);
  });
  it("collapses finished branches into history but expands and focuses them explicitly", () => {
    const values = [row("root", "done"), row("child", "done", "root"), row("live")];
    expect(activityTree(values).map((entry) => [entry.row.id, entry.history])).toEqual([
      ["live", false],
      ["root", true],
    ]);
    expect(
      activityTree(values, { expandedHistory: new Set([values[0]!.key]) }).map(
        (entry) => entry.row.id,
      ),
    ).toEqual(["live", "root", "child"]);
    expect(activityTree(values, { focus: values[2]!.key }).map((entry) => entry.row.id)).toEqual([
      "live",
    ]);
  });
  it("does not archive an owner with a child needing input, including collapsed branches", () => {
    const values = [row("root", "done"), row("question", "needs-input", "root")];
    const tree = activityTree(values, { collapsed: new Set([values[0]!.key]) });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.history).toBe(false);
    expect(needsYou(values).map((entry) => entry.id)).toEqual(["question"]);
  });
  it("bounds completed descendants without dropping live rows or their ancestors", () => {
    const root = row("root");
    const finished = Array.from({ length: 300 }, (_, index) =>
      row(`done-${index}`, "done", "root"),
    );
    const live = Array.from({ length: 200 }, (_, index) => row(`live-${index}`, "running", "root"));
    const retained = retainActivity([root, ...finished], [root, ...live]);
    expect(retained.filter((value) => value.status === "done")).toHaveLength(128);
    expect(retained.filter((value) => value.status === "running")).toHaveLength(201);
    expect(retained.find((value) => value.id === "root")?.omittedChildren).toBe(172);
    const repeated = retainActivity(retained, [root, ...finished, ...live]);
    expect(repeated.find((value) => value.id === "root")?.omittedChildren).toBe(172);
    const owner = row("finished-owner", "done", "root");
    const running = row("running-child", "running", owner.id);
    expect(
      retainActivity([...retained, owner], [root, running]).some((value) => value.id === owner.id),
    ).toBe(true);
  });
  it("bounds completed retention across several live branches", () => {
    const values = Array.from({ length: 12 }, (_, branch) => {
      const root = row(`root-${branch}`);
      return [
        root,
        ...Array.from({ length: 200 }, (_, index) =>
          row(`done-${branch}-${index}`, "done", root.id),
        ),
      ];
    }).flat();
    const retained = retainActivity(
      values,
      values.filter((value) => value.status === "running"),
    );
    expect(retained.filter((value) => value.status === "done").length).toBeLessThanOrEqual(1024);
    expect(retained.filter((value) => value.status === "running")).toHaveLength(12);
  });
  it("bounds finished root history and preserves retained history descendants", () => {
    const previous = Array.from({ length: 120 }, (_, index) => row(String(index), "done"));
    expect(retainActivity(previous, [])).toHaveLength(100);
    const root = row("root", "done");
    expect(
      retainActivity([root, row("child", "done", "root")], [root]).map((entry) => entry.id),
    ).toEqual(["root", "child"]);
  });
});
