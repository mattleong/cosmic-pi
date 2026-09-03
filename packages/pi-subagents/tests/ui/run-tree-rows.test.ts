import { describe, expect, it } from "vitest";
import { projectFleetTree, projectRunCardTree } from "../../src/ui/run-tree-rows.ts";

describe("tool run-card hierarchy", () => {
  it("orders roots and descendants without depending on input order", () => {
    const rows = projectRunCardTree([
      { id: "grandchild", parentRunId: "child" },
      { id: "sibling", parentRunId: "root" },
      { id: "child", parentRunId: "parent" },
      { id: "parent", parentRunId: "root" },
    ]);
    expect(rows.map((row) => row.run.id)).toEqual(["sibling", "parent", "child", "grandchild"]);
  });

  it("keeps incomplete, duplicated, and cyclic bounded card sets visible exactly once", () => {
    const rows = projectRunCardTree([
      { id: "orphan", parentRunId: "omitted-parent" },
      { id: "cycle-a", parentRunId: "cycle-b" },
      { id: "cycle-b", parentRunId: "cycle-a" },
      { id: "orphan", parentRunId: "omitted-parent" },
    ]);
    expect(rows.map((row) => row.run.id).sort()).toEqual(["cycle-a", "cycle-b", "orphan"]);
  });
});

describe("fleet hierarchy", () => {
  const runs = [
    { id: "parent", parentRunId: "root" },
    { id: "child", parentRunId: "parent" },
    { id: "grandchild", parentRunId: "child" },
    { id: "sibling", parentRunId: "root" },
    { id: "stray", parentRunId: "unknown-parent" },
  ];

  it("scopes rows to the visibility root's descendants and never renders the root itself", () => {
    const tree = projectFleetTree(runs, "parent", new Set());
    expect(tree.rows.map((row) => row.run.id)).toEqual(["child", "grandchild"]);
    expect(tree.runs.map((run) => run.id)).toEqual(["child", "grandchild"]);
  });

  it("drops runs outside the scoped subtree instead of promoting them to roots", () => {
    const tree = projectFleetTree(runs, "root", new Set());
    expect(tree.runs.map((run) => run.id)).not.toContain("stray");
    expect(tree.rows.map((row) => row.run.id)).toEqual([
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
  });

  it("hides every descendant of a collapsed run while keeping it in the scoped run set", () => {
    const tree = projectFleetTree(runs, "root", new Set(["parent"]));
    expect(tree.rows.map((row) => row.run.id)).toEqual(["parent", "sibling"]);
    expect(tree.rows[0]).toMatchObject({ hasChildren: true, expanded: false });
    expect(tree.runs.map((run) => run.id)).toEqual(["parent", "child", "grandchild", "sibling"]);
  });

  it("does not re-enter the visibility root through a cycle", () => {
    const tree = projectFleetTree(
      [
        { id: "caller", parentRunId: "child" },
        { id: "child", parentRunId: "caller" },
      ],
      "caller",
      new Set(),
    );
    expect(tree.rows.map((row) => row.run.id)).toEqual(["child"]);
  });
});
