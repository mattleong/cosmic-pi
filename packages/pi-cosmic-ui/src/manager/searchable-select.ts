import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { stripTerminalControls } from "pi-cosmic-core/security";
import {
  fuzzyFilter,
  Input,
  visibleWidth,
  type Component,
  type Focusable,
  type SelectItem,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { clipToWidth } from "./chrome.ts";
import {
  framedBodyWithHints,
  framedFill,
  framedScreen,
  listDetailFrame,
} from "./list-detail-shell.ts";
import { isListMotion, nextListMotionIndex } from "./list-navigation.ts";
import {
  FULL_SCREEN_NAVIGATION_SHORTCUTS,
  FullScreenKeymap,
  pageSteps,
  type FullScreenSelectionKeybindingId,
} from "./keymap.ts";
import {
  configuredKeyLabels,
  exitKeyHint,
  framedKeyHints,
  helpKeyHint,
  keyHint,
  keyHintRows,
  TEXT_INPUT_KEY_LABELS,
  type FramedKeyHints,
} from "./key-labels.ts";
import { focusedField, LIST_CURSOR, selectionMarker } from "./style.ts";

/** Labels keep this column, so descriptions shown with `? More` line up. */
const PRIMARY_COLUMN = 32;
const MIN_DESCRIPTION_WIDTH = 10;
const CURSOR = `${LIST_CURSOR} `;
const NO_CURSOR = "  ";

const singleLine = (text: string): string => Str.trim(Str.replace(/[\r\n]+/g, " ")(text));

export interface SearchableSelectPageChoice<A> {
  readonly value: string;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly payload: A;
  readonly enabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  readonly disabledHint?: string | undefined;
  readonly tone?: Parameters<Theme["fg"]>[0] | undefined;
}

export interface SearchableSelectHostOptions {
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly matchesKeybinding?:
    | ((data: string, id: FullScreenSelectionKeybindingId) => boolean)
    | undefined;
  readonly keybindingLabel?:
    | ((id: FullScreenSelectionKeybindingId, fallback: string) => string)
    | undefined;
}

export interface SearchableSelectPageOptions<A> extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly breadcrumb: string;
  readonly title: string;
  readonly subtitle: string;
  readonly choices: ReadonlyArray<SearchableSelectPageChoice<A>>;
  /** The row focused on opening. */
  readonly current?: string | undefined;
  /**
   * A value picker's current value. When set, every row carries a single-select marker and this
   * value reads `(•)`. Action and navigation lists leave it unset.
   */
  readonly markedValue?: string | undefined;
  readonly notice?: string | undefined;
  readonly emptyText?: string | undefined;
  readonly initialQuery?: string | undefined;
  readonly initialSearchMode?: boolean | undefined;
  readonly cancelBehavior?: "close" | "clear-search" | undefined;
  readonly select: (value: A) => void;
  readonly cancel: () => void;
}

interface SearchableSelectSearchState {
  readonly query: string;
  readonly active: boolean;
}

export class SearchableSelectPage<A> implements Component, Focusable {
  private readonly input = new Input();
  private readonly options: SearchableSelectPageOptions<A>;
  private query: string;
  private filtered: ReadonlyArray<SearchableSelectPageChoice<A>>;
  private selectedIndex = 0;
  private listHeight: number;
  private feedback: string | undefined;
  private searchMode: boolean;
  private selectedIdentity: string | undefined;
  private alternateHelp = false;
  private hasFocus = false;
  private readonly keymap = new FullScreenKeymap();

  constructor(options: SearchableSelectPageOptions<A>) {
    this.options = options;
    this.query = options.initialQuery ?? "";
    this.filtered = options.choices;
    this.listHeight = this.resolveListHeight();
    this.searchMode = options.initialSearchMode ?? Boolean(options.initialQuery);
    this.selectedIdentity = options.current ?? options.choices[0]?.value;
    if (this.query) this.input.setValue(this.query);
    this.refilter();
    this.input.focused = false;
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  get selectedValue(): string | undefined {
    return this.selectedIdentity;
  }

  get searchState(): SearchableSelectSearchState {
    return { query: this.query, active: this.searchMode };
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && this.searchMode;
  }

  private resolveListHeight(): number {
    const height = this.options.getHeight();
    return Math.max(1, height < 10 ? height - 3 : height - 10);
  }

  private resizeList(height: number): void {
    this.listHeight = Math.max(1, height);
  }

  private selectedChoice(): SearchableSelectPageChoice<A> | undefined {
    return this.filtered[this.selectedIndex];
  }

  private refilter(): void {
    this.filtered = fuzzyFilter(
      [...this.options.choices],
      this.query,
      (choice) => choice.searchText,
    );
    const preferred = this.selectedIdentity
      ? Arr.findFirstIndex(this.filtered, (choice) => choice.value === this.selectedIdentity)
      : Option.none();
    this.selectedIndex = Option.getOrElse(preferred, () => 0);
  }

  private rowLabel(choice: SearchableSelectPageChoice<A>): string {
    const marked = this.options.markedValue;
    const marker =
      marked === undefined ? "" : `${selectionMarker("single", choice.value === marked)} `;
    const label = stripTerminalControls(choice.item.label || choice.item.value);
    const hint = choice.enabled === false && choice.disabledHint ? ` · ${choice.disabledHint}` : "";
    return `${marker}${label}${hint}`;
  }

  // `? More` adds each row's description in a second column when there is room for it.
  private rowColumns(choice: SearchableSelectPageChoice<A>, width: number) {
    const label = this.rowLabel(choice);
    const description =
      this.alternateHelp && choice.item.description
        ? singleLine(stripTerminalControls(choice.item.description))
        : "";
    const column = Math.min(PRIMARY_COLUMN, width - 4);
    if (description && column > 2 && width - column > MIN_DESCRIPTION_WIDTH) {
      const shown = clipToWidth(label, column - 2, "…");
      return {
        label: `${shown}${Fn.pipe(" ", Str.repeat(column - visibleWidth(shown)))}`,
        description: clipToWidth(description, width - column, "…"),
      };
    }
    return { label: clipToWidth(label, Math.max(1, width), "…"), description: "" };
  }

  private renderRow(choice: SearchableSelectPageChoice<A>, focused: boolean, width: number) {
    const theme = this.options.theme;
    const { label, description } = this.rowColumns(choice, Math.max(1, width - CURSOR.length));
    const disabled = choice.enabled === false;
    if (focused && !this.searchMode) {
      if (!disabled) return focusedField(theme, `${CURSOR}${label}${description}`);
      const dim = theme.bold(theme.fg("dim", `${CURSOR}${label}${description}`));
      return theme.bg?.("selectedBg", dim) ?? dim;
    }
    // While typing, the query keeps focus; the cursor stays visible but quiet.
    const prefix = focused ? theme.fg("muted", CURSOR) : NO_CURSOR;
    const styled = theme.fg(disabled ? "dim" : (choice.tone ?? "text"), label);
    return `${prefix}${styled}${description ? theme.fg("muted", description) : ""}`;
  }

  /** The visible rows, with `n of N` in the last row when the list scrolls. */
  private renderList(width: number): string[] {
    const theme = this.options.theme;
    const total = this.filtered.length;
    if (total === 0)
      return [
        theme.fg(
          "warning",
          clipToWidth(`  ${this.options.emptyText ?? "No matching options"}`, width, "…"),
        ),
      ];
    const scrolls = total > this.listHeight && this.listHeight > 1;
    const capacity = scrolls ? this.listHeight - 1 : this.listHeight;
    const start = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(capacity / 2), total - capacity),
    );
    const rows = Arr.map(this.filtered.slice(start, start + capacity), (choice, offset) =>
      this.renderRow(choice, start + offset === this.selectedIndex, width),
    );
    return scrolls
      ? [
          ...rows,
          theme.fg("dim", clipToWidth(`  ${this.selectedIndex + 1} of ${total}`, width, "…")),
        ]
      : rows;
  }

  private handleSelectAction(action: string): void {
    switch (action) {
      case "cancel":
        if (this.searchMode && this.options.cancelBehavior !== "close") this.clearSearchAndExit();
        else this.options.cancel();
        break;
      case "quit":
      case "back":
        this.options.cancel();
        break;
      case "confirm":
      case "forward": {
        const choice = this.selectedChoice();
        if (!choice)
          this.feedback = `${this.options.emptyText ?? "No matching options"}; change the search or go back.`;
        else if (choice.enabled === false)
          this.feedback =
            choice.disabledReason ?? `${choice.item.label || choice.value} is unavailable.`;
        else {
          this.selectedIdentity = choice.value;
          this.options.select(choice.payload);
        }
        break;
      }
      case "search":
        this.setSearchMode(true);
        break;
      case "help":
        this.alternateHelp = !this.alternateHelp;
        break;
    }
  }

  handleInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: this.searchMode ? "search" : "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (Predicate.isTagged(resolution, "Action")) {
      if (isListMotion(resolution.action)) {
        if (this.filtered.length > 0) {
          this.selectedIndex = nextListMotionIndex(
            resolution.action,
            this.selectedIndex,
            this.filtered.length,
            pageSteps(this.listHeight - 1),
            true,
          );
          this.selectedIdentity = this.selectedChoice()?.value ?? this.selectedIdentity;
        }
        this.feedback = undefined;
      } else this.handleSelectAction(resolution.action);
      this.options.requestRender();
      return;
    }

    if (this.searchMode) {
      this.input.handleInput(data);
      const next = this.input.getValue();
      if (next !== this.query) {
        this.query = next;
        this.feedback = undefined;
        this.refilter();
      }
      this.options.requestRender();
    }
  }

  private clearSearchAndExit(): void {
    this.setSearchMode(false);
    if (!this.query) return;
    this.query = "";
    this.input.setValue("");
    this.refilter();
  }

  private setSearchMode(active: boolean): void {
    if (this.searchMode === active) return;
    this.searchMode = active;
    this.keymap.resetChord();
    this.input.focused = this.hasFocus && active;
    this.feedback = undefined;
  }

  private keys() {
    return configuredKeyLabels(
      this.options.keybindingLabel,
      this.searchMode ? TEXT_INPUT_KEY_LABELS : FULL_SCREEN_NAVIGATION_SHORTCUTS,
    );
  }

  private searchCancel(): string {
    const verb = this.options.cancelBehavior === "close" ? "Cancel" : "Clear";
    return `${this.keys().key("tui.select.cancel", "Esc")} ${verb}`;
  }

  private footer(inner: number): FramedKeyHints {
    const { key, movement } = this.keys();
    const confirm = key("tui.select.confirm", "Enter");
    const cancel = key("tui.select.cancel", "Esc");
    const move = keyHint(movement ?? "↑↓", "Move");
    const select = keyHint(confirm, "Select");
    if (this.searchMode)
      return framedKeyHints(["Type to filter", move, select], [this.searchCancel()], inner);
    const pages = `${key("tui.select.pageUp", "PgUp")}/${key("tui.select.pageDown", "PgDn")}`;
    const expanded = this.alternateHelp;
    const more = [
      keyHint("j/k", "Move"),
      keyHint(`${pages}/C-u/C-d`, "Page"),
      keyHint("gg/G", "Ends"),
      keyHint("l", "Select"),
    ];
    return framedKeyHints(
      [move, select, keyHint("/", "Filter"), ...(expanded ? more : [])],
      [exitKeyHint("nested", expanded ? ["h", "q"] : [], cancel), helpKeyHint(expanded)],
      inner,
    );
  }

  private compactBody(
    bodyHeight: number,
    inner: number,
    activeNotice: string | undefined,
  ): string[] {
    const theme = this.options.theme;
    const noticeLine = activeNotice
      ? theme.fg("warning", clipToWidth(activeNotice, inner, "…"))
      : undefined;
    const inputLine = this.searchMode
      ? Arr.map(this.input.render(Math.max(1, inner)).slice(0, 1), (line) =>
          focusedField(theme, line),
        )[0]
      : undefined;
    if (bodyHeight === 1) {
      const single = inputLine ?? noticeLine;
      if (single) return [single];
      this.resizeList(1);
      return this.renderList(inner).slice(0, 1);
    }
    if (bodyHeight <= 1) return [];
    const compactHeader = [
      ...(inputLine ? [inputLine] : []),
      ...(noticeLine ? [noticeLine] : []),
      ...(bodyHeight > 3 ? [theme.fg("accent", theme.bold(this.options.title))] : []),
    ].slice(0, bodyHeight - 1);
    const listRows = Math.max(1, bodyHeight - compactHeader.length);
    this.resizeList(listRows);
    return [...compactHeader, ...this.renderList(inner).slice(0, listRows)];
  }

  private fullBody(bodyHeight: number, inner: number, activeNotice: string | undefined): string[] {
    const theme = this.options.theme;
    const limitedWrap = (value: string, maximumLines: number): ReadonlyArray<string> => {
      const lines = wrapTextWithAnsi(value, Math.max(1, inner));
      if (lines.length <= maximumLines) return lines;
      const shown = lines.slice(0, maximumLines);
      shown[maximumLines - 1] = clipToWidth(`${shown[maximumLines - 1] ?? ""}…`, inner, "");
      return shown;
    };
    const noticeLines = activeNotice
      ? Arr.map(limitedWrap(activeNotice, 2), (line) => theme.fg("warning", line))
      : [];
    const subtitleLines = Arr.map(limitedWrap(this.options.subtitle, 1), (line) =>
      theme.fg("dim", line),
    );
    // The footer carries the search keys; the body shows only the query.
    const searchLines = this.searchMode
      ? Arr.map(this.input.render(Math.max(1, inner)), (line) => focusedField(theme, line))
      : [];
    const header = [
      theme.fg("accent", theme.bold(this.options.title)),
      ...subtitleLines,
      ...noticeLines,
      ...searchLines,
      "",
    ];
    const desiredListHeight = Math.max(1, bodyHeight - header.length);
    this.resizeList(desiredListHeight);
    return [...header, ...this.renderList(inner).slice(0, desiredListHeight)];
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    if (safeWidth < 4)
      return Array.from({ length: height }, () => Fn.pipe(" ", Str.repeat(safeWidth)));
    const inner = safeWidth - 2;
    const title = clipToWidth(` ${this.options.breadcrumb} `, inner, "");
    const frame = listDetailFrame(this.options.theme, "list");
    const activeNotice = this.feedback ?? this.options.notice;
    const footer = this.footer(inner);
    const hints = keyHintRows(footer.overflow, inner, (row) => this.options.theme.fg("dim", row));
    return framedScreen(frame, {
      width: safeWidth,
      height,
      top: title,
      bottom: footer.border,
      body: (fullHeight) =>
        framedBodyWithHints(frame, { height: fullHeight, inner, hints }, (bodyHeight) =>
          framedFill(
            frame,
            height < 10
              ? this.compactBody(bodyHeight, inner, activeNotice)
              : this.fullBody(bodyHeight, inner, activeNotice),
            bodyHeight,
            inner,
            "list",
          ),
        ),
    });
  }

  invalidate(): void {
    this.input.invalidate();
  }
}
