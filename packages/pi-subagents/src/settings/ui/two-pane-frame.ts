import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { borderKeyHint, keyHintRows, type FramedKeyHints } from "pi-cosmic-ui/manager/key-labels";
import type { ListDetailPane } from "pi-cosmic-ui/manager/list-detail";
import {
  FRAME_GUTTER,
  framedBodyWithHints,
  framedBodyWithPrompt,
  framedFill,
  framedGutter,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
  type ListDetailShell,
} from "pi-cosmic-ui/manager/list-detail-shell";
import type { DashboardPrompt } from "./profile-dashboard-render.ts";

/** Text width inside a pane, between its gutters. */
const textWidth = (paneWidth: number): number => Math.max(1, paneWidth - 2 * FRAME_GUTTER);

type PaneRows = (textWidth: number, height: number) => ReadonlyArray<string>;

interface TwoPaneFrameOptions {
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  /** The whole surface's height, which with the width decides how panes are arranged. */
  readonly frameHeight: number;
  /** Pane focus and the arrangement, synced to the frame before anything is drawn. */
  readonly shell: ListDetailShell;
  /** Whether the list has a row for the detail pane to show; without one, focus returns to it. */
  readonly hasSelection: boolean;
  /** The pane showing focus, read once the shell is synced. */
  readonly focusedPane: () => ListDetailPane;
  /** A pending decision in a band above the border; it holds the keys, so no pane shows focus. */
  readonly prompt: DashboardPrompt | undefined;
  /** A page drawn in the detail pane, whose key hints replace the tab's own. */
  readonly page: { readonly keyHints: (inner: number) => FramedKeyHints } | undefined;
  readonly footer: (inner: number) => FramedKeyHints;
  /** Pane widths when the panes sit side by side. */
  readonly columns: (inner: number) => {
    readonly listWidth: number;
    readonly detailWidth: number;
  };
  /** Rows for a body too short for panes, shown unless a page is open. */
  readonly compact?: ((textWidth: number) => ReadonlyArray<string>) | undefined;
  /** Lines the list takes of a stacked body `bodyHeight` lines tall. */
  readonly stackedListHeight: (bodyHeight: number, textWidth: number) => number;
  /** Whether a single pane shows the detail even though neither the shell nor a page asks for it. */
  readonly singleShowsDetail: boolean;
  readonly list: PaneRows;
  readonly detail: PaneRows;
}

/**
 * The frame both dashboard tabs draw: a list and a detail pane side by side, stacked, or one at a
 * time as the frame allows, above a prompt band or the key hints that don't fit the bottom border.
 */
export const renderTwoPaneFrame = (options: TwoPaneFrameOptions): string[] => {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height));
  if (width === 0 || height === 0) return [];
  if (width < 4) return Array.from({ length: height }, () => Fn.pipe(" ", Str.repeat(width)));
  const { theme, shell, prompt, page } = options;
  const inner = width - 2;
  const arrangement = shell.syncArrangement(width, options.frameHeight);
  shell.ensureSelectionPane(options.hasSelection);
  const frame = listDetailFrame(theme, prompt ? undefined : options.focusedPane());
  const columns = arrangement === "columns" ? options.columns(inner) : undefined;
  const hints: FramedKeyHints = prompt
    ? { border: borderKeyHint(prompt.hint, inner), overflow: "" }
    : page
      ? page.keyHints(inner)
      : options.footer(inner);
  const hintRows = keyHintRows(hints.overflow, inner, (row) => theme.fg("dim", row));
  const text = textWidth(inner);
  const panes = (bodyHeight: number): ReadonlyArray<string> => {
    if (options.compact && bodyHeight <= 4 && !page)
      return framedFill(
        frame,
        framedGutter(options.compact(text), inner),
        bodyHeight,
        inner,
        "list",
      );
    if (columns)
      return framedWideRows(frame, {
        left: framedGutter(
          options.list(textWidth(columns.listWidth), bodyHeight),
          columns.listWidth,
        ),
        right: framedGutter(
          options.detail(textWidth(columns.detailWidth), bodyHeight),
          columns.detailWidth,
        ),
        height: bodyHeight,
        listWidth: columns.listWidth,
        detailWidth: columns.detailWidth,
      });
    if (arrangement === "stacked" && bodyHeight >= 6) {
      const listHeight = options.stackedListHeight(bodyHeight, text);
      return framedStackedRows(frame, {
        list: framedGutter(options.list(text, listHeight), inner),
        detail: framedGutter(options.detail(text, bodyHeight - listHeight - 1), inner),
        height: bodyHeight,
        inner,
      });
    }
    // One pane at a time: the detail, or a page opened from either pane, replaces the list.
    const detail = shell.state.details || page !== undefined || options.singleShowsDetail;
    return framedFill(
      frame,
      framedGutter(
        detail ? options.detail(text, bodyHeight) : options.list(text, bodyHeight),
        inner,
      ),
      bodyHeight,
      inner,
      detail ? "detail" : "list",
    );
  };
  return framedScreen(frame, {
    width,
    height,
    // The pane rule meets the top border, which a host may turn into a divider.
    top: columns
      ? `${frame.outer(Fn.pipe("─", Str.repeat(columns.listWidth)))}${frame.inner("┬")}`
      : "",
    bottom: hints.border,
    body: (fullHeight) =>
      prompt
        ? framedBodyWithPrompt(
            frame,
            { height: fullHeight, inner, prompt: prompt.text, columns },
            panes,
          )
        : framedBodyWithHints(
            frame,
            { height: fullHeight, inner, hints: hintRows, columns },
            panes,
          ),
  });
};
