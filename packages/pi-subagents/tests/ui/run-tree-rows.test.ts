import { describe, expect, it } from "vitest";
import { projectFleetTree, projectRunCardTree } from "../../src/ui/run-tree-rows.ts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

describe("tool run-card hierarchy", () => {
  it("keeps incomplete, duplicated, and cyclic bounded card sets visible exactly once", () => {
    const rows = projectRunCardTree([
      { id: "orphan", parentRunId: "omitted-parent" },
      { id: "cycle-a", parentRunId: "cycle-b" },
      { id: "cycle-b", parentRunId: "cycle-a" },
      { id: "orphan", parentRunId: "omitted-parent" },
    ]);
    expect(
      Arr.sort(
        Arr.map(rows, (row) => row.run.id),
        Order.String,
      ),
    ).toEqual(["cycle-a", "cycle-b", "orphan"]);
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

  it("drops runs outside the scoped subtree instead of promoting them to roots", () => {
    const tree = projectFleetTree(runs, "root");
    expect(Arr.map(tree.runs, (run) => run.id)).not.toContain("stray");
    expect(Arr.map(tree.rows, (row) => row.run.id)).toEqual([
      "parent",
      "child",
      "grandchild",
      "sibling",
    ]);
  });

  it("does not re-enter the visibility root through a cycle", () => {
    const tree = projectFleetTree(
      [
        { id: "caller", parentRunId: "child" },
        { id: "child", parentRunId: "caller" },
      ],
      "caller",
    );
    expect(Arr.map(tree.rows, (row) => row.run.id)).toEqual(["child"]);
  });
});
