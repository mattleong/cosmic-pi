import { describe, expect, it } from "@effect/vitest";
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
