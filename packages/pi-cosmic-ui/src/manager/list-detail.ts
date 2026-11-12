import { visibleWidth } from "@earendil-works/pi-tui";
import * as Data from "effect/Data";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { type FullScreenAction, type PageSteps } from "./keymap.ts";
import {
  isListMotion,
  isMovementMotion,
  movementOffset,
  type ListMotion,
} from "./list-navigation.ts";
import { clipToWidth, joinInline, type ManagerArrangement } from "./chrome.ts";

export type ListDetailPane = "list" | "detail";

export const padListDetailRow = (text: string, width: number): string => {
  const clipped = clipToWidth(text, Math.max(0, width), "");
  return `${clipped}${Fn.pipe(" ", Str.repeat(Math.max(0, width - visibleWidth(clipped))))}`;
};

export interface ListSelectionChange {
  readonly selected: number;
  readonly selectedId: string | undefined;
  readonly changed: boolean;
}

export const clampListIndex = (index: number, count: number): number =>
  Math.max(0, Math.min(Math.max(0, count - 1), index));

export type ListDetailMotion = ListMotion | "cancel" | "quit" | "back" | "forward";

export const listDetailMotionFromAction = (
  action: FullScreenAction,
): ListDetailMotion | undefined =>
  isListMotion(action) ||
  action === "cancel" ||
  action === "quit" ||
  action === "back" ||
  action === "forward"
    ? action
    : undefined;

export interface ListDetailMotionState {
  readonly pane: ListDetailPane;
  readonly details: boolean;
  readonly selected: number;
  readonly detailScroll: number;
}

interface ListDetailMotionContext {
  readonly arrangement: ManagerArrangement;
  readonly rowCount: number;
  readonly hasSelection: boolean;
  readonly detailMaxScroll: number;
  readonly detailSteps: PageSteps;
  readonly listSteps: PageSteps;
}

type ListDetailMotionResult = Data.TaggedEnum<{
  Close: Record<never, never>;
  Ignored: Record<never, never>;
  Update: {
    readonly state: ListDetailMotionState;
    readonly resetChord: boolean;
    readonly scrolledDetail: boolean;
    readonly movedSelection: boolean;
  };
}>;
const ListDetailMotionResult = Data.taggedEnum<ListDetailMotionResult>();

type MotionFlags = Partial<{
  resetChord: boolean;
  scrolledDetail: boolean;
  movedSelection: boolean;
}>;

const motionUpdate = (
  state: ListDetailMotionState,
  next: Partial<ListDetailMotionState>,
  flags?: MotionFlags,
): ListDetailMotionResult =>
  ListDetailMotionResult.Update({
    state: { ...state, ...next },
    resetChord: flags?.resetChord ?? false,
    scrolledDetail: flags?.scrolledDetail ?? false,
    movedSelection: flags?.movedSelection ?? false,
  });

const scrollDetail = (
  state: ListDetailMotionState,
  context: ListDetailMotionContext,
  delta: number,
): ListDetailMotionResult =>
  motionUpdate(
    state,
    { detailScroll: Math.max(0, Math.min(context.detailMaxScroll, state.detailScroll + delta)) },
    { scrolledDetail: true },
  );

const selectRow = (
  state: ListDetailMotionState,
  context: ListDetailMotionContext,
  index: number,
): ListDetailMotionResult =>
  motionUpdate(
    state,
    { selected: clampListIndex(index, context.rowCount) },
    { movedSelection: true },
  );

const leaveDetail = (
  state: ListDetailMotionState,
  motion: "cancel" | "back",
  browsingDetail: boolean,
): ListDetailMotionResult =>
  browsingDetail
    ? motionUpdate(state, { pane: "list", details: false, detailScroll: 0 }, { resetChord: true })
    : motion === "cancel"
      ? ListDetailMotionResult.Close()
      : ListDetailMotionResult.Ignored();

const enterDetail = (
  state: ListDetailMotionState,
  context: ListDetailMotionContext,
): ListDetailMotionResult =>
  context.hasSelection
    ? motionUpdate(
        state,
        { pane: "detail", details: context.arrangement === "single" ? true : state.details },
        { resetChord: true },
      )
    : ListDetailMotionResult.Ignored();

type NamedMotion = Exclude<ListDetailMotion, Parameters<typeof movementOffset>[0]>;
type NamedMotionHandler = (
  state: ListDetailMotionState,
  context: ListDetailMotionContext,
  browsingDetail: boolean,
) => ListDetailMotionResult;

const NAMED_MOTIONS = {
  cancel: (state, _context, browsingDetail) => leaveDetail(state, "cancel", browsingDetail),
  back: (state, _context, browsingDetail) => leaveDetail(state, "back", browsingDetail),
  quit: () => ListDetailMotionResult.Close(),
  forward: (state, context) => enterDetail(state, context),
  first: (state, context, browsingDetail) =>
    browsingDetail
      ? scrollDetail(state, context, context.detailMaxScroll)
      : selectRow(state, context, 0),
  last: (state, context, browsingDetail) =>
    browsingDetail
      ? scrollDetail(state, context, -context.detailMaxScroll)
      : selectRow(state, context, context.rowCount - 1),
} satisfies Record<NamedMotion, NamedMotionHandler>;

export const listDetailMotion = (
  state: ListDetailMotionState,
  motion: ListDetailMotion,
  context: ListDetailMotionContext,
): ListDetailMotionResult => {
  const browsingDetail =
    state.pane === "detail" || (context.arrangement === "single" && state.details);
  if (isMovementMotion(motion)) {
    return browsingDetail
      ? scrollDetail(state, context, -movementOffset(motion, context.detailSteps))
      : selectRow(state, context, state.selected + movementOffset(motion, context.listSteps));
  }
  return NAMED_MOTIONS[motion](state, context, browsingDetail);
};

interface DetailWindow {
  readonly visible: ReadonlyArray<string>;
  readonly scroll: number;
  readonly maxScroll: number;
  readonly pageSize: number;
  readonly lineCount: number;
  readonly overflow:
    | { readonly start: number; readonly end: number; readonly total: number }
    | undefined;
}

export type DetailWindowPosition = boolean | "top" | undefined;

export const computeDetailWindow = (options: {
  readonly lines: ReadonlyArray<string>;
  readonly height: number;
  readonly previous: Pick<DetailWindow, "scroll" | "lineCount"> &
    Partial<Pick<DetailWindow, "maxScroll">>;
  readonly follow?: DetailWindowPosition;
}): DetailWindow => {
  const { lines, height, previous } = options;
  if (height <= 0) {
    return {
      visible: [],
      scroll: previous.scroll,
      maxScroll: 0,
      pageSize: 1,
      lineCount: previous.lineCount,
      overflow: undefined,
    };
  }
  let scroll = options.follow === true ? 0 : previous.scroll;
  const hasOverflow = lines.length > height;
  const bodyHeight = hasOverflow && height > 1 ? height - 1 : height;
  const anchored = options.follow === false || scroll > 0;
  if (anchored && lines.length > previous.lineCount) scroll += lines.length - previous.lineCount;
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  // A view resting at the top stays there when the pane resizes or help takes rows.
  const atTop =
    options.follow !== true &&
    previous.maxScroll !== undefined &&
    previous.lineCount > 0 &&
    previous.scroll >= previous.maxScroll;
  scroll = options.follow === "top" || atTop ? maxScroll : Math.min(scroll, maxScroll);
  const start = Math.max(0, lines.length - bodyHeight - scroll);
  return {
    visible: lines.slice(start, start + bodyHeight),
    scroll,
    maxScroll,
    pageSize: Math.max(1, bodyHeight),
    lineCount: lines.length,
    overflow:
      hasOverflow && height > 1
        ? { start: start + 1, end: Math.min(lines.length, start + bodyHeight), total: lines.length }
        : undefined,
  };
};

export const detailWindowPositionLabel = (
  overflow: NonNullable<DetailWindow["overflow"]>,
): string => `lines ${overflow.start}–${overflow.end} of ${overflow.total}`;

interface ListDetailPaneGeometry {
  readonly inner: number;
  readonly listWidth: number;
  readonly detailWidth: number;
}

export const wideListDetailGeometry = (
  width: number,
  minListWidth: number,
  listRatio: number,
): ListDetailPaneGeometry => {
  const inner = width - 2;
  const listWidth = Math.max(minListWidth, Math.floor(inner * listRatio));
  return { inner, listWidth, detailWidth: inner - listWidth - 1 };
};

/**
 * Lines a stacked list takes from a body `height` lines tall: what its content needs, up to two
 * fifths of the body, and at least three. Pass `contentLines` as every line the list would draw,
 * heading included, counting a row that wraps onto a continuation line as two.
 */
export const stackedListHeight = (height: number, contentLines: number): number =>
  Math.max(3, Math.min(contentLines, Math.floor(height * 0.4)));

/** Rows `start` up to, not including, `end`. */
export interface ListWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * Rows of varying height that fit `limit` lines with the selected row whole and centred where
 * the list allows, as `listWindowStart` does for single-line rows.
 */
export const listWindowByHeight = (
  heights: ReadonlyArray<number>,
  selected: number,
  limit: number,
): ListWindow => {
  const lines = Math.max(1, limit);
  const tops: number[] = [];
  let total = 0;
  for (const height of heights) {
    tops.push(total);
    total += Math.max(1, height);
  }
  if (!heights.length) return { start: 0, end: 0 };
  const index = clampListIndex(selected, heights.length);
  const top = tops[index] ?? 0;
  const own = Math.max(1, heights[index] ?? 1);
  const first = Math.max(0, Math.min(total - lines, top - Math.floor((lines - own) / 2)));
  let start = index;
  while (start > 0 && (tops[start - 1] ?? 0) >= first) start--;
  let end = start;
  const bottom = (tops[start] ?? 0) + lines;
  while (end < heights.length && (tops[end] ?? 0) + Math.max(1, heights[end] ?? 1) <= bottom) end++;
  return { start, end: Math.max(end, Math.min(heights.length, index + 1)) };
};

/**
 * Where a list window sits in `count` rows, as `2 more above · 7 more below`, or `undefined` when
 * every row is on screen. Pane headings show it beside their title (`paneHeadingText`).
 */
export const listWindowPositionLabel = (window: ListWindow, count: number): string | undefined => {
  const above = Math.max(0, window.start);
  const below = Math.max(0, count - window.end);
  const label = joinInline([
    above ? `${above} more above` : undefined,
    below ? `${below} more below` : undefined,
  ]);
  return label || undefined;
};

export const listWindowStart = (count: number, selected: number, limit: number): number => {
  const size = Math.max(1, limit);
  return Math.max(0, Math.min(Math.max(0, count - size), selected - Math.floor(size / 2)));
};
