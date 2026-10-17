import { describe, expect, it } from "vitest";
import {
  activitySectionId,
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
});
