import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type * as Types from "effect/Types";
import { managerLayoutTier, type ManagerLayoutTier } from "./chrome.ts";
import { FullScreenKeymap, pageSteps } from "./keymap.ts";
import {
  computeDetailWindow,
  listDetailMotion,
  listWindowStart,
  padListDetailRow,
  reconcileListSelection,
  selectListIndex,
  type ListDetailMotion,
  type ListDetailPane,
  type ListDetailMotionState,
  type ListSelectionChange,
} from "./list-detail.ts";

export interface ListDetailShellState extends ListDetailMotionState {
  readonly selectedId: string | undefined;
  readonly layout: ManagerLayoutTier;
}

/** Generic list/detail state. Callers retain input resolution, policy, rendering, and copy. */
export class ListDetailShell {
  readonly keymap = new FullScreenKeymap();
  private current: Types.Mutable<ListDetailShellState> = {
    pane: "list",
    details: false,
    selected: 0,
    selectedId: undefined,
    layout: "narrow",
    detailScroll: 0,
  };
  private detailMaxScroll = 0;
  private detailLineCount = 0;
  private detailPageSize = 1;
  private listPageSize = 1;

  get state(): ListDetailShellState {
    return this.current;
  }

  private applySelection(change: ListSelectionChange): ListSelectionChange {
    this.current.selected = change.selected;
    this.current.selectedId = change.selectedId;
    if (change.changed) this.current.detailScroll = 0;
    return change;
  }

  select(index: number, ids: ReadonlyArray<string>): ListSelectionChange {
    return this.applySelection(selectListIndex(this.current, index, ids));
  }

  reconcile(ids: ReadonlyArray<string>): ListSelectionChange {
    return this.applySelection(reconcileListSelection(this.current, ids));
  }

  syncLayout(width: number): ManagerLayoutTier {
    const layout = managerLayoutTier(width);
    if (layout !== this.current.layout) {
      this.current.layout = layout;
      if (layout === "narrow") this.current.details = this.current.pane === "detail";
      this.keymap.resetChord();
    }
    return layout;
  }

  ensureSelectionPane(hasSelection: boolean): void {
    if (hasSelection || this.current.pane !== "detail") return;
    this.current.pane = "list";
    this.current.details = false;
    this.keymap.resetChord();
  }

  /** Caller-owned Enter policy decides when to invoke this transition. */
  enterPane(): void {
    const details = this.current.layout === "narrow" ? !this.current.details : this.current.details;
    this.current.pane = this.current.layout === "narrow" && !details ? "list" : "detail";
    this.current.details = details;
    this.current.detailScroll = 0;
    this.keymap.resetChord();
  }

  applyMotion(
    motion: ListDetailMotion,
    context: { readonly rowCount: number; readonly hasSelection: boolean },
  ) {
    const result = listDetailMotion(this.current, motion, {
      layout: this.current.layout,
      rowCount: context.rowCount,
      hasSelection: context.hasSelection,
      detailMaxScroll: this.detailMaxScroll,
      detailSteps: pageSteps(this.detailPageSize),
      listSteps: pageSteps(this.listPageSize),
    });
    if (result._tag === "Update") {
      this.current.pane = result.state.pane;
      this.current.details = result.state.details;
      this.current.detailScroll = result.state.detailScroll;
      if (result.resetChord) this.keymap.resetChord();
    }
    return result;
  }

  detailWindow(lines: ReadonlyArray<string>, height: number, follow?: boolean | undefined) {
    const window = computeDetailWindow({
      lines,
      height,
      previous: { scroll: this.current.detailScroll, lineCount: this.detailLineCount },
      follow,
    });
    this.current.detailScroll = window.scroll;
    this.detailMaxScroll = window.maxScroll;
    this.detailPageSize = window.pageSize;
    this.detailLineCount = window.lineCount;
    return window;
  }

  resetDetailScroll(): void {
    this.current.detailScroll = 0;
  }

  resetDetailWindow(): void {
    this.detailMaxScroll = 0;
    this.detailLineCount = 0;
  }

  visibleWindow(count: number, limit: number) {
    this.listPageSize = Math.max(1, limit);
    const start = listWindowStart(count, this.current.selected, limit);
    return { start, end: start + this.listPageSize };
  }
}

export interface ListDetailFrame {
  readonly outer: (text: string) => string;
  readonly inner: (text: string) => string;
}

/** Derive from the current pane each render; omitted focus preserves neutral single-pane frames. */
export const listDetailFrame = (
  theme: Pick<Theme, "fg">,
  focusedPane?: ListDetailPane,
): ListDetailFrame => ({
  outer: (text) => theme.fg("borderAccent", text),
  inner: (text) => theme.fg(focusedPane === "detail" ? "borderAccent" : "borderMuted", text),
});

/** Caller-sanitized heading with a stable marker gutter as focus moves between panes. */
export const listDetailHeading = (
  theme: Pick<Theme, "fg" | "bold">,
  text: string,
  focused: boolean,
): string => theme.fg(focused ? "accent" : "muted", `${focused ? "› " : "  "}${theme.bold(text)}`);

export interface ListDetailField {
  readonly label: string;
  readonly value: string;
  readonly tone?: "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";
}

/** Align a group of caller-sanitized fields. Callers retain wrapping and disclosure policy. */
export const detailFieldRows = (
  theme: Pick<Theme, "fg">,
  fields: ReadonlyArray<ListDetailField>,
  minimumLabelWidth = 10,
): ReadonlyArray<string> => {
  const labelWidth = Math.max(
    minimumLabelWidth,
    ...fields.map((field) => visibleWidth(field.label)),
  );
  return fields.map(
    (field) =>
      `${theme.fg("dim", padListDetailRow(field.label, labelWidth))}  ${theme.fg(field.tone ?? "text", field.value)}`,
  );
};

export const framedRow = (frame: ListDetailFrame, line: string, inner: number) =>
  `${frame.outer("│")}${padListDetailRow(line, inner)}${frame.outer("│")}`;

export const framedFill = (
  frame: ListDetailFrame,
  rows: ReadonlyArray<string>,
  height: number,
  inner: number,
) =>
  Array.from({ length: Math.max(0, height) }, (_, index) =>
    framedRow(frame, rows[index] ?? "", inner),
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
      `${frame.outer("│")}${padListDetailRow(options.left[index] ?? "", options.listWidth)}${frame.inner(
        "│",
      )}${padListDetailRow(options.right[index] ?? "", options.detailWidth)}${frame.outer("│")}`,
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
  const divider = `${frame.outer("├")}${frame.inner("─".repeat(options.inner))}${frame.outer("┤")}`;
  const rows = [
    ...options.list.map((line) => framedRow(frame, line, options.inner)),
    divider,
    ...options.detail.map((line) => framedRow(frame, line, options.inner)),
  ].slice(0, Math.max(0, options.height));
  return [
    ...rows,
    ...framedFill(frame, [], Math.max(0, options.height - rows.length), options.inner),
  ];
};

/** Composes fixed-height top/body/bottom rows. Callers supply already themed content. */
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
    `${"─".repeat(Math.max(0, width - visibleWidth(options.top) - 2))}╮`,
  )}`;
  if (height === 1) return [truncateToWidth(top, width, "")];
  if (width === 1) return Array.from({ length: height }, () => " ");
  const bottom = `${frame.outer(
    `╰${"─".repeat(Math.max(0, width - visibleWidth(options.bottom) - 2))}`,
  )}${options.bottom}${frame.outer("╯")}`;
  return [
    truncateToWidth(top, width, ""),
    ...options.body(height - 2),
    truncateToWidth(bottom, width, ""),
  ];
};
