import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import type * as Types from "effect/Types";
import {
  clipToWidth,
  joinInline,
  managerArrangement,
  wrapFacts,
  type ManagerArrangement,
} from "./chrome.ts";
import { FullScreenKeymap, pageSteps } from "./keymap.ts";
import {
  clampListIndex,
  computeDetailWindow,
  listDetailMotion,
  listWindowByHeight,
  listWindowStart,
  padListDetailRow,
  type DetailWindowPosition,
  type ListDetailMotion,
  type ListDetailPane,
  type ListDetailMotionState,
  type ListSelectionChange,
} from "./list-detail.ts";

interface ListDetailShellState extends ListDetailMotionState {
  readonly selectedId: string | undefined;
  readonly arrangement: ManagerArrangement;
}

export class ListDetailShell {
  readonly keymap = new FullScreenKeymap();
  private readonly current: Types.Mutable<ListDetailShellState> = {
    pane: "list",
    details: false,
    selected: 0,
    selectedId: undefined,
    arrangement: "single",
    detailScroll: 0,
  };
  private detailMaxScroll = 0;
  private detailLineCount = 0;
  private detailPageSize = 1;
  private listPageSize = 1;
  /** The first detail line to keep in view through the next window, across a pane change. */
  private heldDetailStart: number | undefined;

  get state(): ListDetailShellState {
    return this.current;
  }

  select(index: number, ids: ReadonlyArray<string>): ListSelectionChange {
    const selected = clampListIndex(index, ids.length);
    const selectedId = ids[selected];
    const changed = this.current.selectedId !== selectedId;
    this.current.selected = selected;
    this.current.selectedId = selectedId;
    if (changed) this.current.detailScroll = 0;
    return { selected, selectedId, changed };
  }

  reconcile(ids: ReadonlyArray<string>): ListSelectionChange {
    const { selected, selectedId } = this.current;
    const existing = selectedId === undefined ? -1 : ids.indexOf(selectedId);
    return this.select(existing >= 0 ? existing : selected, ids);
  }

  /**
   * Arranges the panes for a frame `width` by `height` (`managerArrangement`). Entering a single
   * pane keeps whichever pane had focus on screen.
   */
  syncArrangement(width: number, height: number): ManagerArrangement {
    const arrangement = managerArrangement(width, height);
    if (arrangement !== this.current.arrangement) {
      this.current.arrangement = arrangement;
      if (arrangement === "single") this.current.details = this.current.pane === "detail";
      this.keymap.resetChord();
    }
    return arrangement;
  }

  ensureSelectionPane(hasSelection: boolean): void {
    if (hasSelection || this.current.pane !== "detail") return;
    this.current.pane = "list";
    this.current.details = false;
    this.keymap.resetChord();
  }

  enterPane(): void {
    const single = this.current.arrangement === "single";
    const details = single ? !this.current.details : this.current.details;
    this.current.pane = single && !details ? "list" : "detail";
    this.current.details = details;
    this.holdDetailStart();
    this.keymap.resetChord();
  }

  /**
   * Entering or leaving the detail pane keeps the reader's place: the line at the top of the
   * detail stays there, even when the pane then shows fuller content, unless it is followed.
   */
  private holdDetailStart(): void {
    this.heldDetailStart = Math.max(0, this.detailMaxScroll - this.current.detailScroll);
  }

  applyMotion(
    motion: ListDetailMotion,
    context: { readonly rowCount: number; readonly hasSelection: boolean },
  ) {
    const result = listDetailMotion(this.current, motion, {
      arrangement: this.current.arrangement,
      rowCount: context.rowCount,
      hasSelection: context.hasSelection,
      detailMaxScroll: this.detailMaxScroll,
      detailSteps: pageSteps(this.detailPageSize),
      listSteps: pageSteps(this.listPageSize),
    });
    if (Predicate.isTagged(result, "Update")) {
      if (result.state.pane !== this.current.pane || result.state.details !== this.current.details)
        this.holdDetailStart();
      this.current.pane = result.state.pane;
      this.current.details = result.state.details;
      this.current.detailScroll = result.state.detailScroll;
      if (result.resetChord) this.keymap.resetChord();
    }
    return result;
  }

  detailWindow(lines: ReadonlyArray<string>, height: number, follow?: DetailWindowPosition) {
    const held = this.heldDetailStart;
    this.heldDetailStart = undefined;
    const computed = computeDetailWindow({
      lines,
      height,
      previous: {
        scroll: this.current.detailScroll,
        lineCount: this.detailLineCount,
        maxScroll: this.detailMaxScroll,
      },
      follow,
    });
    // Scroll counts up from the last line, so a held first line is `maxScroll - start` from it.
    const window =
      held === undefined || follow === true || follow === "top"
        ? computed
        : computeDetailWindow({
            lines,
            height,
            previous: {
              scroll: Math.max(0, computed.maxScroll - held),
              lineCount: lines.length,
            },
          });
    this.current.detailScroll = window.scroll;
    this.detailMaxScroll = window.maxScroll;
    this.detailPageSize = window.pageSize;
    this.detailLineCount = window.lineCount;
    return window;
  }

  /** Whether the detail pane rests at its first line, so the reader hasn't scrolled into it. */
  get detailAtTop(): boolean {
    return this.current.detailScroll >= this.detailMaxScroll;
  }

  resetDetailWindow(): void {
    this.detailMaxScroll = 0;
    this.detailLineCount = 0;
  }

  /**
   * The rows to show around the selection. Pass `heights` when rows can take more than one line;
   * `limit` then counts lines, and the window keeps the selected row whole.
   */
  visibleWindow(count: number, limit: number, heights?: ReadonlyArray<number>) {
    if (heights === undefined) {
      this.listPageSize = Math.max(1, limit);
      const start = listWindowStart(count, this.current.selected, limit);
      return { start, end: start + this.listPageSize };
    }
    const window = listWindowByHeight(heights, this.current.selected, limit);
    this.listPageSize = Math.max(1, window.end - window.start);
    return window;
  }
}

export interface ListDetailFrame {
  readonly outer: (text: string) => string;
  readonly inner: (text: string) => string;
  readonly pane?: (pane: ListDetailPane, text: string) => string;
}

export const listDetailFrame = (
  theme: Pick<Theme, "fg">,
  focusedPane?: ListDetailPane,
): ListDetailFrame => ({
  outer: (text) => theme.fg("borderMuted", text),
  inner: (text) => theme.fg(focusedPane ? "borderAccent" : "borderMuted", text),
  pane: (pane, text) => theme.fg(focusedPane === pane ? "borderAccent" : "borderMuted", text),
});

/** Pane focus shows through color alone; `›` is reserved for the focused row. */
export const listDetailHeading = (
  theme: Pick<Theme, "fg" | "bold">,
  text: string,
  focused: boolean,
  tone: Parameters<Theme["fg"]>[0] = "muted",
): string => theme.fg(focused ? "accent" : tone, theme.bold(text));

export interface ListDetailField {
  readonly label: string;
  readonly value: string;
  readonly tone?: Parameters<Theme["fg"]>[0];
}

// Narrower than this, a field's value moves beneath its label rather than squeeze its column.
const MIN_FIELD_VALUE_WIDTH = 16;

/**
 * `Label  value` rows with labels in one column. Given a width, a long value wraps between whole
 * facts under its own column, so no row ends with `·` or `→`.
 */
export const detailFieldRows = (
  theme: Pick<Theme, "fg">,
  fields: ReadonlyArray<ListDetailField>,
  width?: number,
): ReadonlyArray<string> => {
  const labelWidth = Math.max(10, ...Arr.map(fields, (field) => visibleWidth(field.label)));
  const column = labelWidth + 2;
  return Arr.flatMap(fields, (field) => {
    const label = theme.fg("dim", padListDetailRow(field.label, labelWidth));
    const tone = (text: string) => theme.fg(field.tone ?? "text", text);
    if (width === undefined) return [`${label}  ${tone(field.value)}`];
    if (width - column < MIN_FIELD_VALUE_WIDTH)
      return [
        theme.fg("dim", field.label),
        ...Arr.map(wrapFacts(field.value, Math.max(1, width - 2), ""), (line) => `  ${tone(line)}`),
      ];
    const [first = "", ...rest] = wrapFacts(field.value, width - column, "");
    return [
      `${label}  ${tone(first)}`,
      ...Arr.map(rest, (line) => `${Fn.pipe(" ", Str.repeat(column))}${tone(line)}`),
    ];
  });
};

const framedRow = (frame: ListDetailFrame, line: string, inner: number, pane?: ListDetailPane) => {
  const edge = pane && frame.pane ? frame.pane(pane, "│") : frame.outer("│");
  return `${edge}${padListDetailRow(line, inner)}${edge}`;
};

export const framedFill = (
  frame: ListDetailFrame,
  rows: ReadonlyArray<string>,
  height: number,
  inner: number,
  pane?: ListDetailPane,
) =>
  Array.from({ length: Math.max(0, height) }, (_, index) =>
    framedRow(frame, rows[index] ?? "", inner, pane),
  );

export const framedWideRows = (
  frame: ListDetailFrame,
  options: {
    readonly left: ReadonlyArray<string>;
    readonly right: ReadonlyArray<string>;
    readonly height: number;
    readonly listWidth: number;
    readonly detailWidth: number;
  },
) =>
  Array.from(
    { length: options.height },
    (_, index) =>
      `${frame.pane?.("list", "│") ?? frame.outer("│")}${padListDetailRow(options.left[index] ?? "", options.listWidth)}${frame.inner(
        "│",
      )}${padListDetailRow(options.right[index] ?? "", options.detailWidth)}${frame.pane?.("detail", "│") ?? frame.outer("│")}`,
  );

export const framedStackedRows = (
  frame: ListDetailFrame,
  options: {
    readonly list: ReadonlyArray<string>;
    readonly detail: ReadonlyArray<string>;
    readonly height: number;
    readonly inner: number;
  },
) => {
  const divider = `${frame.outer("├")}${frame.inner(Fn.pipe("─", Str.repeat(options.inner)))}${frame.outer("┤")}`;
  const rows = [
    ...Arr.map(options.list, (line) => framedRow(frame, line, options.inner, "list")),
    divider,
    ...Arr.map(options.detail, (line) => framedRow(frame, line, options.inner, "detail")),
  ].slice(0, Math.max(0, options.height));
  return [
    ...rows,
    ...framedFill(frame, [], Math.max(0, options.height - rows.length), options.inner, "detail"),
  ];
};

const horizontalRule = (width: number) => Fn.pipe("─", Str.repeat(Math.max(0, width)));

/** A rule across a frame's body; a two-pane layout passes its pane widths to close the column rule. */
export const framedDivider = (
  frame: ListDetailFrame,
  inner: number,
  columns?: { readonly listWidth: number; readonly detailWidth: number },
): string =>
  columns
    ? `${frame.outer("├")}${frame.outer(horizontalRule(columns.listWidth))}${frame.inner("┴")}${frame.outer(horizontalRule(columns.detailWidth))}${frame.outer("┤")}`
    : `${frame.outer("├")}${frame.outer(horizontalRule(inner))}${frame.outer("┤")}`;

/** Columns a frame keeps between its left border and its text. */
export const FRAME_GUTTER = 1;

/**
 * Sets text one column in from a frame's left border, as panels, hint rows, and detail panes do.
 * `width` is the pane's full inner width; each row is clipped to the room left after the gutter.
 */
export const framedGutter = (rows: ReadonlyArray<string>, width: number): string[] =>
  Arr.map(rows, (row) =>
    row ? ` ${clipToWidth(row, Math.max(0, width - FRAME_GUTTER), "")}` : row,
  );

/**
 * Places wrapped hint rows (`keyHintRows`) between a framed body and its bottom border, set off
 * by a divider. A two-pane layout passes its pane widths so the divider closes the column rule.
 * The rows give way only when the body is too short to show content beside them.
 */
export const framedBodyWithHints = (
  frame: ListDetailFrame,
  options: {
    readonly height: number;
    readonly inner: number;
    readonly hints: ReadonlyArray<string>;
    readonly columns?: { readonly listWidth: number; readonly detailWidth: number } | undefined;
  },
  body: (height: number) => ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const { height, inner, hints, columns } = options;
  if (!hints.length || height <= hints.length + 4) return body(height);
  return [
    ...body(height - hints.length - 1),
    framedDivider(frame, inner, columns),
    ...framedFill(frame, hints, hints.length, inner),
  ];
};

// A prompt band leaves at least this many body rows above it before it takes the whole body.
const PROMPT_CONTEXT_ROWS = 3;

/** The first `limit` lines; when lines were cut, the last one kept ends with `…` within `width`. */
export const firstLines = (
  lines: ReadonlyArray<string>,
  limit: number,
  width: number,
): string[] => {
  const shown = lines.slice(0, limit);
  if (lines.length > limit)
    shown[limit - 1] = `${clipToWidth(shown[limit - 1] ?? "", width - 1, "")}…`;
  return shown;
};

/**
 * Places a prompt, such as a confirmation, in a band between a framed body and its bottom border,
 * set off by a divider, so the panes above stay in view while the border names the decision keys.
 * `prompt` may be styled; it wraps inside the frame's gutters. Pass lines instead when the band
 * holds a row that must not wrap, such as a text input: each is kept whole, cut to the gutters'
 * width. A two-pane layout passes its pane widths so the divider closes the column rule. A frame too short to show the body beside the band
 * gives the prompt the whole body, ending with `…` if even that cuts it short. To add wrapped hint
 * rows as well, wrap this in `framedBodyWithHints` without `columns`.
 */
export const framedBodyWithPrompt = (
  frame: ListDetailFrame,
  options: {
    readonly height: number;
    readonly inner: number;
    readonly prompt: string | ReadonlyArray<string>;
    readonly columns?: { readonly listWidth: number; readonly detailWidth: number } | undefined;
  },
  body: (height: number) => ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const { height, inner, columns } = options;
  if (height <= 0) return [];
  const room = Math.max(1, inner - 2 * FRAME_GUTTER);
  const wrapped = Predicate.isString(options.prompt)
    ? wrapTextWithAnsi(options.prompt, room)
    : Arr.map(options.prompt, (line) => clipToWidth(line, room, ""));
  if (height >= wrapped.length + 1 + PROMPT_CONTEXT_ROWS)
    return [
      ...body(height - wrapped.length - 1),
      framedDivider(frame, inner, columns),
      ...framedFill(frame, framedGutter(wrapped, inner), wrapped.length, inner),
    ];
  return framedFill(frame, framedGutter(firstLines(wrapped, height, room), inner), height, inner);
};

/**
 * A pane heading's text: its title, then where its rows sit when they scroll, from
 * `listWindowPositionLabel` or `detailWindowPositionLabel` (`Items · 2 more above`,
 * `Details · lines 1–22 of 27`), cut to `width`. Style it with `listDetailHeading`.
 */
export const paneHeadingText = (
  title: string,
  position: string | undefined,
  width: number,
): string => clipToWidth(joinInline([title, position]), width, "…");

export const framedScreen = (
  frame: ListDetailFrame,
  options: {
    readonly width: number;
    readonly height: number;
    readonly top: string;
    readonly bottom: string;
    readonly body: (bodyHeight: number) => ReadonlyArray<string>;
  },
) => {
  const { width, height } = options;
  if (width <= 0 || height <= 0) return [];
  const top = `${frame.outer("╭")}${options.top}${frame.outer(
    `${Fn.pipe("─", Str.repeat(Math.max(0, width - visibleWidth(options.top) - 2)))}╮`,
  )}`;
  if (height === 1) return [clipToWidth(top, width, "")];
  if (width === 1) return Array.from({ length: height }, () => " ");
  const bottom = `${frame.outer(
    `╰${Fn.pipe("─", Str.repeat(Math.max(0, width - visibleWidth(options.bottom) - 2)))}`,
  )}${options.bottom}${frame.outer("╯")}`;
  return [clipToWidth(top, width, ""), ...options.body(height - 2), clipToWidth(bottom, width, "")];
};
