import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import {
  framedFill,
  framedRow,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  ListDetailShell,
  type ListDetailFrame,
} from "../src/manager/list-detail-shell.ts";

const frame: ListDetailFrame = { outer: (text) => text, inner: (text) => text };
const lines = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `L${index + 1}`);
const ids = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `row-${index}`);

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

  it("resets the detail scroll only when the row identity changes", () => {
    const shell = new ListDetailShell();
    shell.syncLayout(120);
    shell.select(0, ["a", "b"]);
    shell.enterPane();
    shell.detailWindow(lines(30), 11);
    shell.applyMotion("half-page-up", { rowCount: 2, hasSelection: true });
    expect(shell.state.detailScroll).toBe(5);

    expect(shell.reconcile(["a", "b"]).changed).toBe(false);
    expect(shell.state.detailScroll).toBe(5);
    expect(shell.select(1, ["a", "b"]).changed).toBe(true);
    expect(shell.state.detailScroll).toBe(0);
  });
});

describe("ListDetailShell motions", () => {
  it("returns Esc from the detail pane to the list and closes from the list; q always closes", () => {
    const shell = new ListDetailShell();
    shell.syncLayout(120);
    shell.select(0, ["a"]);
    shell.enterPane();
    expect(shell.state.pane).toBe("detail");

    expect(shell.applyMotion("cancel", { rowCount: 1, hasSelection: true })._tag).toBe("Update");
    expect(shell.state.pane).toBe("list");
    expect(shell.applyMotion("cancel", { rowCount: 1, hasSelection: true })._tag).toBe("Close");

    shell.enterPane();
    expect(shell.applyMotion("quit", { rowCount: 1, hasSelection: true })._tag).toBe("Close");
  });

  it("steps list motions by the rendered page size and leaves selection application to callers", () => {
    const shell = new ListDetailShell();
    shell.syncLayout(120);
    shell.reconcile(ids(50));
    shell.visibleWindow(50, 10);

    const half = shell.applyMotion("half-page-down", { rowCount: 50, hasSelection: true });
    expect(half).toMatchObject({
      _tag: "Update",
      movedSelection: true,
      state: { selected: 5 },
    });
    expect(shell.state.selected).toBe(0);
    shell.select(5, ids(50));

    const full = shell.applyMotion("full-page-down", { rowCount: 50, hasSelection: true });
    expect(full).toMatchObject({
      _tag: "Update",
      movedSelection: true,
      state: { selected: 15 },
    });
    expect(shell.applyMotion("last", { rowCount: 50, hasSelection: true })).toMatchObject({
      state: { selected: 49 },
    });
    expect(shell.applyMotion("first", { rowCount: 50, hasSelection: true })).toMatchObject({
      state: { selected: 0 },
    });
  });

  it("scrolls the focused detail pane by its own page size and reports scrolledDetail", () => {
    const shell = new ListDetailShell();
    shell.syncLayout(120);
    shell.select(0, ["a"]);
    shell.enterPane();
    shell.visibleWindow(50, 18);
    shell.detailWindow(lines(30), 11);

    const result = shell.applyMotion("half-page-up", { rowCount: 1, hasSelection: true });
    expect(result).toMatchObject({ _tag: "Update", scrolledDetail: true, movedSelection: false });
    expect(shell.state.detailScroll).toBe(5);
    shell.applyMotion("first", { rowCount: 1, hasSelection: true });
    expect(shell.state.detailScroll).toBe(20);
    shell.applyMotion("last", { rowCount: 1, hasSelection: true });
    expect(shell.state.detailScroll).toBe(0);
  });

  it("ignores forward without a selection and falls back to the list pane when none remains", () => {
    const shell = new ListDetailShell();
    shell.syncLayout(120);
    expect(shell.applyMotion("forward", { rowCount: 0, hasSelection: false })._tag).toBe("Ignored");

    shell.reconcile(["a"]);
    shell.applyMotion("forward", { rowCount: 1, hasSelection: true });
    expect(shell.state.pane).toBe("detail");
    shell.ensureSelectionPane(false);
    expect(shell.state.pane).toBe("list");
    expect(shell.state.details).toBe(false);
  });

  it("cannot scroll after the detail window bookkeeping was reset", () => {
    const shell = new ListDetailShell();
    shell.syncLayout(120);
    shell.select(0, ["a"]);
    shell.enterPane();
    shell.detailWindow(lines(30), 6);
    shell.resetDetailWindow();
    expect(shell.applyMotion("up", { rowCount: 1, hasSelection: true })).toMatchObject({
      scrolledDetail: true,
      movedSelection: false,
      state: { detailScroll: 0 },
    });
    expect(shell.state.detailScroll).toBe(0);
    shell.applyMotion("back", { rowCount: 1, hasSelection: true });
    expect(shell.applyMotion("up", { rowCount: 1, hasSelection: true })).toMatchObject({
      movedSelection: true,
      scrolledDetail: false,
      state: { selected: 0 },
    });
  });
});

describe("ListDetailShell layout", () => {
  it("maps widths to tiers and re-derives the narrow inspector from the focused pane", () => {
    const shell = new ListDetailShell();
    expect(shell.syncLayout(120)).toBe("wide");
    shell.select(0, ["a"]);
    shell.enterPane();
    expect(shell.state.details).toBe(false);

    expect(shell.syncLayout(50)).toBe("narrow");
    expect(shell.state.details).toBe(true);
    expect(shell.syncLayout(70)).toBe("stacked");

    shell.syncLayout(50);
    shell.enterPane();
    expect(shell.state.details).toBe(false);
    expect(shell.state.pane).toBe("list");
  });
});

describe("ListDetailShell detail window", () => {
  it("keeps the tri-state follow semantics through shell bookkeeping", () => {
    const shell = new ListDetailShell();
    let window = shell.detailWindow(lines(20), 6, true);
    expect(window.visible.at(-1)).toBe("L20");
    expect(window.overflow).toMatchObject({ start: 16, end: 20, total: 20 });

    window = shell.detailWindow(lines(25), 6, false);
    expect(window.visible.at(-1)).toBe("L20");
    expect(window.scroll).toBe(5);

    window = shell.detailWindow(lines(25), 6, true);
    expect(window.visible.at(-1)).toBe("L25");

    const noPolicy = new ListDetailShell();
    noPolicy.detailWindow(lines(20), 6);
    window = noPolicy.detailWindow(lines(25), 6);
    expect(window.visible.at(-1)).toBe("L25");
  });

  it("centers the selection inside the visible list window", () => {
    const shell = new ListDetailShell();
    shell.select(10, ids(20));
    expect(shell.visibleWindow(20, 5)).toEqual({ start: 8, end: 13 });
    shell.select(0, ids(20));
    expect(shell.visibleWindow(20, 5)).toEqual({ start: 0, end: 5 });
    shell.select(19, ids(20));
    expect(shell.visibleWindow(20, 5)).toEqual({ start: 15, end: 20 });
  });
});

describe("frame helpers", () => {
  it("clips and fills rows within the requested geometry", () => {
    const row = framedRow(frame, "hi", 4);
    expect(row).toContain("hi");
    expect(visibleWidth(row)).toBe(6);

    const source = ["a", "long"];
    const filled = framedFill(frame, source, 3, 3);
    expect(filled).toHaveLength(3);
    expect(filled.every((line) => visibleWidth(line) === 5)).toBe(true);
    expect(filled.some((line) => line.includes("lon"))).toBe(true);
    expect(source).toEqual(["a", "long"]);

    const wide = framedWideRows(frame, {
      left: ["a"],
      right: [],
      height: 4,
      listWidth: 3,
      detailWidth: 3,
    });
    expect(wide).toHaveLength(4);
    expect(wide.every((line) => visibleWidth(line) === 9)).toBe(true);

    const stacked = framedStackedRows(frame, {
      list: ["a", "b"],
      detail: ["c"],
      height: 6,
      inner: 4,
    });
    expect(stacked).toHaveLength(6);
    expect(stacked.every((line) => visibleWidth(line) === 6)).toBe(true);

    const clipped = framedStackedRows(frame, {
      list: lines(9),
      detail: ["c"],
      height: 4,
      inner: 4,
    });
    expect(clipped).toHaveLength(4);
    expect(clipped.every((line) => visibleWidth(line) === 6)).toBe(true);
  });

  it("composes the screen with degenerate-size fallbacks and the remaining body height", () => {
    const body = (height: number) => lines(height);
    expect(framedScreen(frame, { width: 0, height: 5, top: "t", bottom: "b", body })).toEqual([]);
    expect(framedScreen(frame, { width: 10, height: 0, top: "t", bottom: "b", body })).toEqual([]);
    const oneRow = framedScreen(frame, {
      width: 10,
      height: 1,
      top: "top",
      bottom: "b",
      body,
    });
    expect(oneRow).toHaveLength(1);
    expect(oneRow.every((line) => visibleWidth(line) <= 10)).toBe(true);

    const singleCell = framedScreen(frame, {
      width: 1,
      height: 1,
      top: "t",
      bottom: "b",
      body,
    });
    expect(singleCell).toHaveLength(1);
    expect(singleCell.every((line) => visibleWidth(line) <= 1)).toBe(true);

    const oneColumn = framedScreen(frame, {
      width: 1,
      height: 3,
      top: "t",
      bottom: "b",
      body,
    });
    expect(oneColumn).toHaveLength(3);
    expect(oneColumn.every((line) => visibleWidth(line) <= 1)).toBe(true);

    const seen: number[] = [];
    const rows = framedScreen(frame, {
      width: 10,
      height: 5,
      top: "t",
      bottom: "b",
      body: (height) => {
        seen.push(height);
        return lines(height);
      },
    });
    expect(seen).toEqual([3]);
    expect(rows).toHaveLength(5);
    expect(rows.every((line) => visibleWidth(line) <= 10)).toBe(true);
  });
});
