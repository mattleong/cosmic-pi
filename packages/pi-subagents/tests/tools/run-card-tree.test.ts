import { describe, expect, it } from "vitest";
import { projectRunCardTree } from "../../src/tools/run-card-tree.ts";

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

  it("keeps incomplete and cyclic bounded card sets visible exactly once", () => {
    const rows = projectRunCardTree([
      { id: "orphan", parentRunId: "omitted-parent" },
      { id: "cycle-a", parentRunId: "cycle-b" },
      { id: "cycle-b", parentRunId: "cycle-a" },
    ]);
    expect(rows.map((row) => row.run.id).sort()).toEqual(["cycle-a", "cycle-b", "orphan"]);
  });
});
