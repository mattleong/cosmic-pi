import { visibleWidth } from "@earendil-works/pi-tui";
import type { ManagerLayoutTier } from "./chrome.ts";
import {
  decodeFullScreenPrintable,
  type FullScreenAction,
  type FullScreenResolution,
  type PageSteps,
} from "./keymap.ts";
import {
  isListMotion,
  isMovementMotion,
  movementOffset,
  type ListMotion,
} from "./list-navigation.ts";
import { clipToWidth } from "./chrome.ts";

export type ListDetailPane = "list" | "detail";

export const padListDetailRow = (text: string, width: number): string => {
  const clipped = clipToWidth(text, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
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
  readonly layout: ManagerLayoutTier;
  readonly rowCount: number;
  readonly hasSelection: boolean;
  readonly detailMaxScroll: number;
  readonly detailSteps: PageSteps;
  readonly listSteps: PageSteps;
}

type ListDetailMotionResult =
  | { readonly _tag: "Close" }
  | { readonly _tag: "Ignored" }
  | {
      readonly _tag: "Update";
      readonly state: ListDetailMotionState;
      readonly resetChord: boolean;
      readonly scrolledDetail: boolean;
      readonly movedSelection: boolean;
    };

export const listDetailMotion = (
  state: ListDetailMotionState,
  motion: ListDetailMotion,
  context: ListDetailMotionContext,
): ListDetailMotionResult => {
  const browsingDetail = state.pane === "detail" || (context.layout === "narrow" && state.details);
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
  if (isMovementMotion(motion)) {
    return browsingDetail
      ? scroll(-movementOffset(motion, context.detailSteps))
      : select(state.selected + movementOffset(motion, context.listSteps));
  }
  switch (motion) {
    case "cancel":
    case "back":
      return browsingDetail
        ? update({ pane: "list", details: false, detailScroll: 0 }, { resetChord: true })
        : { _tag: motion === "cancel" ? "Close" : "Ignored" };
    case "quit":
      return { _tag: "Close" };
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
    case "first":
      return browsingDetail ? scroll(context.detailMaxScroll) : select(0);
    case "last":
      return browsingDetail ? scroll(-context.detailMaxScroll) : select(context.rowCount - 1);
  }
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
  readonly previous: Pick<DetailWindow, "scroll" | "lineCount">;
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
  scroll = options.follow === "top" ? maxScroll : Math.min(scroll, maxScroll);
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
): string => ` ${overflow.start}–${overflow.end} of ${overflow.total} · C-u/d half-page `;

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

export const stackedListHeight = (height: number, rowCount: number): number =>
  Math.max(3, Math.min(rowCount + 1, Math.floor(height * 0.4)));

export const listWindowStart = (count: number, selected: number, limit: number): number => {
  const size = Math.max(1, limit);
  return Math.max(0, Math.min(Math.max(0, count - size), selected - Math.floor(size / 2)));
};

export const confirmedReservedShortcut = (
  resolution: FullScreenResolution | undefined,
  data: string,
  key: string,
): boolean =>
  resolution?._tag === "Shortcut" &&
  resolution.key === key &&
  decodeFullScreenPrintable(data) === key;
