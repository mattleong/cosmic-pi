/**
 * Pure, closed list/detail primitives shared by full-screen extension managers
 * (`/subagents`, `/tasks`): selection clamping/reconciliation, the shared modeless motion
 * reducer, bounded detail windows with the standardized position label, pane geometry, row
 * windowing, width padding, and reserved-shortcut confirmation resolution. The module has no
 * domain imports and takes no host callbacks; callers own row rendering, actions, prompts,
 * and follow policy.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ManagerLayoutTier } from "./chrome.ts";
import {
  decodeFullScreenPrintable,
  type FullScreenAction,
  type FullScreenResolution,
  type PageSteps,
} from "./keymap.ts";

export type ListDetailPane = "list" | "detail";

/** Clips and space-pads one row to an exact display width. */
export const padListDetailRow = (text: string, width: number): string => {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
};

export interface ListSelection {
  readonly selected: number;
  readonly selectedId: string | undefined;
}

export interface ListSelectionChange extends ListSelection {
  /** True when the selected row identity changed; callers reset row-scoped state on it. */
  readonly changed: boolean;
}

export const clampListIndex = (index: number, count: number): number =>
  Math.max(0, Math.min(Math.max(0, count - 1), index));

/** Moves the selection to a clamped index over the current row identities. */
export const selectListIndex = (
  current: ListSelection,
  index: number,
  ids: ReadonlyArray<string>,
): ListSelectionChange => {
  const selected = clampListIndex(index, ids.length);
  const selectedId = ids[selected];
  return { selected, selectedId, changed: current.selectedId !== selectedId };
};

/** Re-finds the selected row after a projection update, keeping the index when it vanished. */
export const reconcileListSelection = (
  current: ListSelection,
  ids: ReadonlyArray<string>,
): ListSelectionChange => {
  const existing = current.selectedId === undefined ? -1 : ids.indexOf(current.selectedId);
  return selectListIndex(current, existing >= 0 ? existing : current.selected, ids);
};

/** True when motions target the detail pane (focused detail or expanded narrow inspector). */
export const browsingListDetail = (
  pane: ListDetailPane,
  details: boolean,
  layout: ManagerLayoutTier,
): boolean => pane === "detail" || (layout === "narrow" && details);

export type ListDetailMotion =
  | "cancel"
  | "quit"
  | "back"
  | "forward"
  | "up"
  | "down"
  | "half-page-up"
  | "half-page-down"
  | "full-page-up"
  | "full-page-down"
  | "first"
  | "last";

/** Maps resolved keymap actions onto the closed shared motion vocabulary. */
export const listDetailMotionFromAction = (
  action: FullScreenAction,
): ListDetailMotion | undefined => {
  switch (action) {
    case "cancel":
    case "quit":
    case "back":
    case "forward":
    case "up":
    case "down":
    case "half-page-up":
    case "half-page-down":
    case "full-page-up":
    case "full-page-down":
    case "first":
    case "last":
      return action;
    default:
      return undefined;
  }
};

export interface ListDetailMotionState {
  readonly pane: ListDetailPane;
  /** Narrow-layout expanded inspector flag. */
  readonly details: boolean;
  readonly selected: number;
  readonly detailScroll: number;
}

export interface ListDetailMotionContext {
  readonly layout: ManagerLayoutTier;
  readonly rowCount: number;
  readonly hasSelection: boolean;
  readonly detailMaxScroll: number;
  readonly detailSteps: PageSteps;
  readonly listSteps: PageSteps;
}

export type ListDetailMotionResult =
  | { readonly _tag: "Close" }
  | { readonly _tag: "Ignored" }
  | {
      readonly _tag: "Update";
      readonly state: ListDetailMotionState;
      readonly resetChord: boolean;
      /** Detail scroll changed; callers apply follow policy from the new scroll. */
      readonly scrolledDetail: boolean;
      /** List selection moved; callers run their selection side effects. */
      readonly movedSelection: boolean;
    };

/**
 * Shared modeless motion reducer for list/detail managers. Esc semantics are standardized:
 * in the detail pane it returns to the list; on the list it closes. `q` always closes.
 * Enter/confirm stays caller-owned because open/toggle policy is layout- and domain-specific.
 */
export const listDetailMotion = (
  state: ListDetailMotionState,
  motion: ListDetailMotion,
  context: ListDetailMotionContext,
): ListDetailMotionResult => {
  const browsingDetail = browsingListDetail(state.pane, state.details, context.layout);
  const update = (
    next: Partial<ListDetailMotionState>,
    flags?: Partial<{ resetChord: boolean; scrolledDetail: boolean; movedSelection: boolean }>,
  ): ListDetailMotionResult => ({
    _tag: "Update",
    state: { ...state, ...next },
    resetChord: flags?.resetChord ?? false,
    scrolledDetail: flags?.scrolledDetail ?? false,
    movedSelection: flags?.movedSelection ?? false,
  });
  const scroll = (delta: number): ListDetailMotionResult =>
    update(
      {
        detailScroll: Math.max(0, Math.min(context.detailMaxScroll, state.detailScroll + delta)),
      },
      { scrolledDetail: true },
    );
  const select = (index: number): ListDetailMotionResult =>
    update({ selected: clampListIndex(index, context.rowCount) }, { movedSelection: true });
  switch (motion) {
    case "cancel":
      return browsingDetail
        ? update({ pane: "list", details: false, detailScroll: 0 }, { resetChord: true })
        : { _tag: "Close" };
    case "quit":
      return { _tag: "Close" };
    case "back":
      return browsingDetail
        ? update({ pane: "list", details: false, detailScroll: 0 }, { resetChord: true })
        : { _tag: "Ignored" };
    case "forward":
      return context.hasSelection
        ? update(
            {
              pane: "detail",
              details: context.layout === "narrow" ? true : state.details,
            },
            { resetChord: true },
          )
        : { _tag: "Ignored" };
    case "up":
      return browsingDetail ? scroll(1) : select(state.selected - 1);
    case "down":
      return browsingDetail ? scroll(-1) : select(state.selected + 1);
    case "half-page-up":
      return browsingDetail
        ? scroll(context.detailSteps.half)
        : select(state.selected - context.listSteps.half);
    case "half-page-down":
      return browsingDetail
        ? scroll(-context.detailSteps.half)
        : select(state.selected + context.listSteps.half);
    case "full-page-up":
      return browsingDetail
        ? scroll(context.detailSteps.page)
        : select(state.selected - context.listSteps.page);
    case "full-page-down":
      return browsingDetail
        ? scroll(-context.detailSteps.page)
        : select(state.selected + context.listSteps.page);
    case "first":
      return browsingDetail ? scroll(context.detailMaxScroll) : select(0);
    case "last":
      return browsingDetail ? scroll(-context.detailMaxScroll) : select(context.rowCount - 1);
  }
};

export interface DetailWindowState {
  readonly scroll: number;
  readonly lineCount: number;
}

export interface DetailWindow {
  readonly visible: ReadonlyArray<string>;
  readonly scroll: number;
  readonly maxScroll: number;
  readonly pageSize: number;
  readonly lineCount: number;
  readonly overflow:
    | { readonly start: number; readonly end: number; readonly total: number }
    | undefined;
}

/**
 * Computes the bottom-anchored detail window: reserves one position row on overflow (only
 * when more than one row exists — a one-row window always shows content and omits the
 * position label), keeps the viewed slice stable while new lines arrive above the fold, and
 * clamps the scroll. `follow: true` pins the window to the newest lines before computing;
 * `follow: false` records an explicit unfollow, so the viewed slice stays anchored even from
 * the bottom (scroll 0) as new lines arrive; `undefined` means the caller has no follow
 * policy and scroll 0 keeps tracking the newest lines.
 */
export const computeDetailWindow = (options: {
  readonly lines: ReadonlyArray<string>;
  readonly height: number;
  readonly previous: DetailWindowState;
  readonly follow?: boolean | undefined;
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
  let scroll = options.follow ? 0 : previous.scroll;
  const hasOverflow = lines.length > height;
  const bodyHeight = hasOverflow && height > 1 ? height - 1 : height;
  const anchored = options.follow === false || scroll > 0;
  if (anchored && lines.length > previous.lineCount) scroll += lines.length - previous.lineCount;
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  scroll = Math.min(scroll, maxScroll);
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

/** Standardized detail position/help copy shared by manager detail panes. */
export const detailWindowPositionLabel = (overflow: {
  readonly start: number;
  readonly end: number;
  readonly total: number;
}): string => ` ${overflow.start}–${overflow.end} of ${overflow.total} · C-u/d half-page `;

export interface ListDetailPaneGeometry {
  readonly inner: number;
  readonly listWidth: number;
  readonly detailWidth: number;
}

/** Wide-layout split with one divider column; the list minimum and ratio stay caller-owned. */
export const wideListDetailGeometry = (
  width: number,
  minListWidth: number,
  listRatio: number,
): ListDetailPaneGeometry => {
  const inner = width - 2;
  const listWidth = Math.max(minListWidth, Math.floor(inner * listRatio));
  return { inner, listWidth, detailWidth: inner - listWidth - 1 };
};

/** Stacked-layout list height: heading row plus rows, capped at 40% of the body. */
export const stackedListHeight = (height: number, rowCount: number): number =>
  Math.max(3, Math.min(rowCount + 1, Math.floor(height * 0.4)));

/** Centers the selection inside a bounded row window; returns the first visible index. */
export const listWindowStart = (count: number, selected: number, limit: number): number => {
  const size = Math.max(1, limit);
  return Math.max(0, Math.min(Math.max(0, count - size), selected - Math.floor(size / 2)));
};

/** True when a reserved-shortcut confirmation was re-pressed (never Esc/other dismissals). */
export const confirmedReservedShortcut = (
  resolution: FullScreenResolution | undefined,
  data: string,
  key: string,
): boolean =>
  resolution?._tag === "Shortcut" &&
  resolution.key === key &&
  decodeFullScreenPrintable(data) === key;
