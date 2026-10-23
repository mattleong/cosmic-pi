import { describe, expect, it } from "vitest";
import { activityPath, retainActivity, type ActivityRow } from "../src/activity/model.ts";
import { groupedActivityTree, type GroupedActivityRow } from "../src/activity/grouped-tree.ts";
import { needsYou } from "../src/activity/attention.ts";
import { activityRow as row } from "./support/activity.ts";

const members = (tree: readonly GroupedActivityRow[]) =>
  tree.filter((entry) => entry.type === "member");

describe("activity ownership", () => {
  it("does not archive an owner with a child needing input, including collapsed branches", () => {
    const values = [row("root", "done"), row("question", "needs-input", "root")];
    const tree = members(groupedActivityTree(values, { collapsed: new Set([values[0]!.key]) }));
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
  it("retains live descendants entering a cycle as independent roots", () => {
    const cycle = [row("a", "done", "b"), row("b", "done", "a")];
    const live = row("live", "running", "a");
    const descendant = row("descendant", "running", "live");
    const history = Array.from({ length: 100 }, (_, index) => row(`history-${index}`, "done"));
    const retained = retainActivity([...history, ...cycle], [live, descendant]);
    expect(retained.some((entry) => entry.id === "a" || entry.id === "b")).toBe(false);
    expect(activityPath(retained, live.key)).toEqual([
      retained.find((entry) => entry.key === live.key),
    ]);
    expect(activityPath([...cycle, live, descendant], descendant.key)).toEqual([descendant]);
    expect(retained.filter((entry) => entry.status === "running").map((entry) => entry.id)).toEqual(
      ["live", "descendant"],
    );
  });
  it("keeps the most recently finished root branches past the history bound", () => {
    let rows: readonly ActivityRow[] = [];
    for (let index = 0; index < 105; index++)
      rows = retainActivity(retainActivity(rows, [row(`dropped-${index}`, "done")]), []);
    expect(new Set(rows.map((entry) => entry.id))).toEqual(
      new Set(Array.from({ length: 100 }, (_, index) => `dropped-${index + 5}`)),
    );
    const published = Array.from({ length: 120 }, (_, index) =>
      row(`published-${index}`, "done", undefined, { endedAt: index }),
    );
    for (const order of [published, published.toReversed()])
      expect(new Set(retainActivity([], order).map((entry) => entry.endedAt))).toEqual(
        new Set(Array.from({ length: 100 }, (_, index) => index + 20)),
      );
  });
});
