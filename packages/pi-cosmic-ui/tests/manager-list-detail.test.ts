import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  clampListIndex,
  computeDetailWindow,
  confirmedReservedShortcut,
  detailWindowPositionLabel,
  listDetailMotion,
  listDetailMotionFromAction,
  listWindowStart,
  padListDetailRow,
  reconcileListSelection,
  selectListIndex,
  stackedListHeight,
  wideListDetailGeometry,
  type ListDetailMotionContext,
  type ListDetailMotionState,
} from "../src/manager/list-detail.ts";

const state = (overrides: Partial<ListDetailMotionState> = {}): ListDetailMotionState => ({
  pane: "list",
  details: false,
  selected: 1,
  detailScroll: 3,
  ...overrides,
});

const context = (overrides: Partial<ListDetailMotionContext> = {}): ListDetailMotionContext => ({
  layout: "wide",
  rowCount: 5,
  hasSelection: true,
  detailMaxScroll: 10,
  detailSteps: { page: 6, half: 3 },
  listSteps: { page: 8, half: 4 },
  ...overrides,
});

describe("shared list/detail primitives", () => {
  it("clamps, selects, and reconciles list selection over row identities", () => {
    expect(clampListIndex(-4, 3)).toBe(0);
    expect(clampListIndex(9, 3)).toBe(2);
    expect(clampListIndex(0, 0)).toBe(0);

    const moved = selectListIndex({ selected: 0, selectedId: "a" }, 2, ["a", "b", "c"]);
    expect(moved).toEqual({ selected: 2, selectedId: "c", changed: true });

    const kept = reconcileListSelection({ selected: 0, selectedId: "b" }, ["a", "b", "c"]);
    expect(kept).toEqual({ selected: 1, selectedId: "b", changed: false });

    const vanished = reconcileListSelection({ selected: 4, selectedId: "gone" }, ["a", "b"]);
    expect(vanished).toEqual({ selected: 1, selectedId: "b", changed: true });
  });

  it("standardizes Esc: detail returns to the list, the list closes, q always closes", () => {
    const fromDetail = listDetailMotion(state({ pane: "detail" }), "cancel", context());
    expect(fromDetail).toMatchObject({
      _tag: "Update",
      state: { pane: "list", details: false, detailScroll: 0 },
      resetChord: true,
    });
    expect(listDetailMotion(state(), "cancel", context())).toEqual({ _tag: "Close" });
    expect(listDetailMotion(state({ pane: "detail" }), "quit", context())).toEqual({
      _tag: "Close",
    });
  });

  it("treats the expanded narrow inspector as the detail pane", () => {
    const narrow = listDetailMotion(
      state({ details: true }),
      "cancel",
      context({ layout: "narrow" }),
    );
    expect(narrow).toMatchObject({ _tag: "Update", state: { pane: "list", details: false } });
  });

  it("routes h/l between panes and ignores forward without a selection", () => {
    const forward = listDetailMotion(state(), "forward", context({ layout: "narrow" }));
    expect(forward).toMatchObject({
      _tag: "Update",
      state: { pane: "detail", details: true },
      resetChord: true,
    });
    expect(listDetailMotion(state(), "forward", context({ hasSelection: false }))).toEqual({
      _tag: "Ignored",
    });
    expect(listDetailMotion(state(), "back", context())).toEqual({ _tag: "Ignored" });
    const back = listDetailMotion(state({ pane: "detail" }), "back", context());
    expect(back).toMatchObject({ _tag: "Update", state: { pane: "list", detailScroll: 0 } });
  });

  it("scrolls the detail pane and moves the list selection with shared steps", () => {
    const scrolled = listDetailMotion(state({ pane: "detail" }), "half-page-up", context());
    expect(scrolled).toMatchObject({
      _tag: "Update",
      state: { detailScroll: 6 },
      scrolledDetail: true,
    });
    const clamped = listDetailMotion(state({ pane: "detail" }), "full-page-up", context());
    expect(clamped).toMatchObject({ _tag: "Update", state: { detailScroll: 9 } });
    const top = listDetailMotion(state({ pane: "detail" }), "first", context());
    expect(top).toMatchObject({ _tag: "Update", state: { detailScroll: 10 } });
    const bottom = listDetailMotion(state({ pane: "detail" }), "last", context());
    expect(bottom).toMatchObject({ _tag: "Update", state: { detailScroll: 0 } });

    const moved = listDetailMotion(state(), "half-page-down", context());
    expect(moved).toMatchObject({ _tag: "Update", state: { selected: 4 }, movedSelection: true });
    const first = listDetailMotion(state(), "first", context());
    expect(first).toMatchObject({ _tag: "Update", state: { selected: 0 } });
  });

  it("maps only closed motion actions from the keymap vocabulary", () => {
    expect(listDetailMotionFromAction("half-page-up")).toBe("half-page-up");
    expect(listDetailMotionFromAction("confirm")).toBeUndefined();
    expect(listDetailMotionFromAction("help")).toBeUndefined();
    expect(listDetailMotionFromAction("search")).toBeUndefined();
  });

  it("computes bottom-anchored detail windows with a stable slice while lines grow", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line-${index}`);
    const bottom = computeDetailWindow({
      lines,
      height: 4,
      previous: { scroll: 0, lineCount: 0 },
    });
    expect(bottom.visible).toEqual(["line-7", "line-8", "line-9"]);
    expect(bottom.overflow).toEqual({ start: 8, end: 10, total: 10 });
    expect(bottom.pageSize).toBe(3);
    expect(bottom.maxScroll).toBe(7);

    const scrolledUp = computeDetailWindow({
      lines,
      height: 4,
      previous: { scroll: 2, lineCount: 10 },
    });
    expect(scrolledUp.visible).toEqual(["line-5", "line-6", "line-7"]);

    const grown = computeDetailWindow({
      lines: [...lines, "line-10", "line-11"],
      height: 4,
      previous: { scroll: 2, lineCount: 10 },
    });
    expect(grown.visible).toEqual(["line-5", "line-6", "line-7"]);
    expect(grown.scroll).toBe(4);

    const followed = computeDetailWindow({
      lines,
      height: 4,
      previous: { scroll: 5, lineCount: 10 },
      follow: true,
    });
    expect(followed.visible).toEqual(["line-7", "line-8", "line-9"]);
    expect(followed.scroll).toBe(0);

    const collapsed = computeDetailWindow({
      lines,
      height: 0,
      previous: { scroll: 5, lineCount: 10 },
    });
    expect(collapsed).toMatchObject({ visible: [], maxScroll: 0, pageSize: 1 });

    expect(
      computeDetailWindow({ lines: ["a"], height: 4, previous: { scroll: 0, lineCount: 0 } }),
    ).toMatchObject({ visible: ["a"], overflow: undefined });
  });

  it("standardizes the detail position copy", () => {
    expect(detailWindowPositionLabel({ start: 8, end: 10, total: 12 })).toBe(
      " 8–10 of 12 · C-u/d half-page ",
    );
  });

  it("shares pane geometry, stacked heights, and row windows", () => {
    expect(wideListDetailGeometry(120, 38, 0.42)).toEqual({
      inner: 118,
      listWidth: 49,
      detailWidth: 68,
    });
    expect(wideListDetailGeometry(90, 38, 0.42)).toMatchObject({ listWidth: 38 });
    expect(stackedListHeight(20, 2)).toBe(3);
    expect(stackedListHeight(20, 30)).toBe(8);
    expect(listWindowStart(20, 10, 5)).toBe(8);
    expect(listWindowStart(3, 0, 5)).toBe(0);
    expect(listWindowStart(20, 19, 5)).toBe(15);
  });

  it("pads rows to exact width and resolves reserved-shortcut confirmations", () => {
    expect(padListDetailRow("ab", 4)).toBe("ab  ");
    // Truncation appends an ANSI reset; the visible slice and width stay exact.
    expect(padListDetailRow("abcdef", 4).startsWith("abcd")).toBe(true);
    expect(visibleWidth(padListDetailRow("abcdef", 4))).toBe(4);
    expect(padListDetailRow("ab", 0)).toBe("");

    expect(confirmedReservedShortcut({ _tag: "Shortcut", key: "x" }, "x", "x")).toBe(true);
    expect(confirmedReservedShortcut({ _tag: "Action", action: "cancel" }, "x", "x")).toBe(false);
    expect(confirmedReservedShortcut(undefined, "x", "x")).toBe(false);
    expect(confirmedReservedShortcut({ _tag: "Shortcut", key: "x" }, "y", "x")).toBe(false);
  });
});
