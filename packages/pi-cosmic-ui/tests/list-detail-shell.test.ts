import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { listWindowByHeight } from "../src/manager/list-detail.ts";
import { ListDetailShell } from "../src/manager/list-detail-shell.ts";

describe("ListDetailShell selection", () => {
  it("keeps the selected identity across reorder and clamps out-of-range targets", () => {
    const shell = new ListDetailShell();
    expect(shell.select(1, ["a", "b", "c"]).changed).toBe(true);
    expect(shell.state.selectedId).toBe("b");

    expect(shell.reconcile(["b", "a", "c"]).changed).toBe(false);
    expect(shell.state.selected).toBe(0);
    expect(shell.state.selectedId).toBe("b");

    shell.select(10, ["a", "b", "c"]);
    expect(shell.state.selected).toBe(2);
    shell.select(-5, ["a", "b", "c"]);
    expect(shell.state.selected).toBe(0);
  });

  it("keeps the index and adopts the new identity when the selected row vanishes", () => {
    const shell = new ListDetailShell();
    shell.select(1, ["a", "b", "c"]);
    const change = shell.reconcile(["a", "c"]);
    expect(change.changed).toBe(true);
    expect(shell.state.selected).toBe(1);
    expect(shell.state.selectedId).toBe("c");
  });

  it("keeps a detail view resting at the top there when its pane shrinks", () => {
    const shell = new ListDetailShell();
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    expect(shell.detailWindow(lines, 40, "top").visible[0]).toBe("line 0");
    expect(shell.detailWindow(lines, 40, false).visible[0]).toBe("line 0");
    expect(shell.detailWindow(lines, 12, false).visible[0]).toBe("line 0");
  });
});

describe("list windows over rows of different heights", () => {
  it("keeps the selected row whole and within the line budget wherever it sits", () => {
    const heights = [1, 2, 1, 2, 2, 1, 1, 2, 1, 2];
    for (let selected = 0; selected < heights.length; selected++)
      for (const limit of [2, 3, 5, 8, 30]) {
        const { start, end } = listWindowByHeight(heights, selected, limit);
        expect(start).toBeLessThanOrEqual(selected);
        expect(end).toBeGreaterThan(selected);
        const used = Arr.reduce(heights.slice(start, end), 0, (total, height) => total + height);
        expect(used).toBeLessThanOrEqual(Math.max(limit, heights[selected] ?? 1));
      }
  });

  it("shows every row when they all fit", () => {
    expect(listWindowByHeight([2, 1, 2], 2, 10)).toEqual({ start: 0, end: 3 });
    expect(listWindowByHeight([], 0, 4)).toEqual({ start: 0, end: 0 });
  });
});
