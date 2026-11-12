import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
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
import { clipToWidth, INLINE_SEPARATOR } from "./chrome.ts";
import {
  FRAME_GUTTER,
  framedBodyWithHints,
  framedFill,
  framedGutter,
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
  framedKeyHintBar,
  framedKeyHints,
  keyHint,
  keyHintRows,
  TEXT_INPUT_KEY_LABELS,
  type FramedKeyHints,
  type KeyHintPart,
} from "./key-labels.ts";
import { focusedField, LIST_CURSOR, selectionMarker } from "./style.ts";

/** Labels keep this column, so descriptions shown with `? More` line up. */
const PRIMARY_COLUMN = 32;
const MIN_DESCRIPTION_WIDTH = 10;
const CURSOR = `${LIST_CURSOR} `;
const NO_CURSOR = "  ";
// Bodies shorter than this drop the subtitle and spacing to keep list rows.
const COMPACT_BELOW = 8;
// A title and subtitle longer than this together read as a sentence, so they keep two lines.
const SHARED_HEADING_WIDTH = 60;

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
  /**
   * The heading this choice is listed under, such as a model's provider. Choices of one group are
   * listed together under one heading, in the order their groups first appear; ungrouped choices,
   * such as an inherit row, come first with no heading. Headings can't be selected or counted.
   */
  readonly group?: string | undefined;
}

/** A row of the visible list: a group heading, or the choice at `index` of the filtered list. */
type ListRow<A> =
  | { readonly kind: "heading"; readonly group: string }
  | {
      readonly kind: "choice";
      readonly index: number;
      readonly choice: SearchableSelectPageChoice<A>;
    };

interface IndexedChoice<A> {
  readonly choice: SearchableSelectPageChoice<A>;
  readonly index: number;
}

/** Ungrouped choices first, then each group together, in the order the groups first appear. */
const groupChoices = <A>(
  choices: ReadonlyArray<SearchableSelectPageChoice<A>>,
  order: ReadonlyMap<string, number>,
): ReadonlyArray<SearchableSelectPageChoice<A>> => {
  if (order.size === 0) return choices;
  const byGroup = Order.combine(
    Order.mapInput(Order.Number, ({ choice }: IndexedChoice<A>) =>
      choice.group === undefined ? -1 : (order.get(choice.group) ?? 0),
    ),
    Order.mapInput(Order.Number, ({ index }: IndexedChoice<A>) => index),
  );
  return Arr.map(
    Arr.sort(
      Arr.map(choices, (choice, index) => ({ choice, index })),
      byGroup,
    ),
    ({ choice }) => choice,
  );
};

const groupOrder = <A>(
  choices: ReadonlyArray<SearchableSelectPageChoice<A>>,
): ReadonlyMap<string, number> => {
  const order = new Map<string, number>();
  for (const { group } of choices)
    if (group !== undefined && !order.has(group)) order.set(group, order.size);
  return order;
};

const choiceRows = <A>(choices: ReadonlyArray<SearchableSelectPageChoice<A>>): ListRow<A>[] => {
  const rows: ListRow<A>[] = [];
  let group: string | undefined;
  for (const [index, choice] of choices.entries()) {
    if (choice.group !== undefined && choice.group !== group)
      rows.push({ kind: "heading", group: choice.group });
    group = choice.group;
    rows.push({ kind: "choice", index, choice });
  }
  return rows;
};

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
  /** Extra default pairs for keys the host handles, such as a picker's `Tab` scope switch. */
  readonly hints?: ReadonlyArray<KeyHintPart> | undefined;
  readonly select: (value: A) => void;
  readonly cancel: () => void;
}

interface SearchableSelectSearchState {
  readonly query: string;
  readonly active: boolean;
}

/**
 * A searchable choice list. `render` draws it as a full-screen framed page. A host can instead
 * place it inside one pane of its own frame: `renderBody` draws the rows without a frame and
 * `keyHints` returns the bar for the host's border, while `handleInput` works the same.
 */
export class SearchableSelectPage<A> implements Component, Focusable {
  private readonly input = new Input();
  private readonly options: SearchableSelectPageOptions<A>;
  private readonly groups: ReadonlyMap<string, number>;
  private query: string;
  private filtered: ReadonlyArray<SearchableSelectPageChoice<A>>;
  private rows: ReadonlyArray<ListRow<A>> = [];
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
    this.groups = groupOrder(options.choices);
    this.query = options.initialQuery ?? "";
    this.filtered = options.choices;
    this.listHeight = this.resolveListHeight();
    this.searchMode = options.initialSearchMode ?? Boolean(options.initialQuery);
    this.selectedIdentity = options.current ?? groupChoices(options.choices, this.groups)[0]?.value;
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
    this.filtered = groupChoices(
      fuzzyFilter([...this.options.choices], this.query, (choice) => choice.searchText),
      this.groups,
    );
    this.rows = choiceRows(this.filtered);
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

  // The row Enter would select is highlighted while the search input has the keys, too.
  private renderRow(choice: SearchableSelectPageChoice<A>, focused: boolean, width: number) {
    const theme = this.options.theme;
    const { label, description } = this.rowColumns(choice, Math.max(1, width - CURSOR.length));
    const disabled = choice.enabled === false;
    if (focused) {
      if (!disabled) return focusedField(theme, `${CURSOR}${label}${description}`);
      const dim = theme.bold(theme.fg("dim", `${CURSOR}${label}${description}`));
      return theme.bg?.("selectedBg", dim) ?? dim;
    }
    const styled = theme.fg(disabled ? "dim" : (choice.tone ?? "text"), label);
    return `${NO_CURSOR}${styled}${description ? theme.fg("muted", description) : ""}`;
  }

  private renderHeading(group: string, width: number): string {
    const theme = this.options.theme;
    return theme.fg("muted", theme.bold(clipToWidth(stripTerminalControls(group), width, "…")));
  }

  /**
   * The rows `height` lines can show around the selection. A group whose heading scrolled away
   * keeps it on the first line, in place of the row beneath it, unless that row is the selection.
   */
  private windowRows(height: number): ReadonlyArray<ListRow<A>> {
    const rows = this.rows;
    const selected = Option.getOrElse(
      Arr.findFirstIndex(rows, (row) => row.kind === "choice" && row.index === this.selectedIndex),
      () => 0,
    );
    const start = Math.max(0, Math.min(selected - Math.floor(height / 2), rows.length - height));
    const shown = rows.slice(start, start + height);
    const [first, second] = shown;
    if (
      start > 0 &&
      height > 1 &&
      selected !== start &&
      first?.kind === "choice" &&
      first.choice.group !== undefined &&
      second?.kind === "choice" &&
      second.choice.group === first.choice.group
    )
      return [{ kind: "heading", group: first.choice.group }, ...shown.slice(1)];
    return shown;
  }

  /** The visible rows, with `n of N` choices in the last row when the list scrolls. */
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
    const scrolls = this.rows.length > this.listHeight && this.listHeight > 1;
    const capacity = scrolls ? this.listHeight - 1 : this.listHeight;
    const rows = Arr.map(this.windowRows(capacity), (row) =>
      row.kind === "heading"
        ? this.renderHeading(row.group, width)
        : this.renderRow(row.choice, row.index === this.selectedIndex, width),
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
    return keyHint(this.keys().primary("tui.select.cancel", "Esc"), verb);
  }

  /**
   * The page's key hints for a border `inner` columns wide: the border text and the pairs that
   * overflow it. A host embedding the page puts these in its own border, wrapping the overflow
   * with `keyHintRows`. Default bars name only the primary configured keys; cancel aliases such as
   * `C-c` join the expanded exit pair.
   */
  keyHints(inner: number): FramedKeyHints {
    const { key, binding, primary, movement } = this.keys();
    const cancel = binding("tui.select.cancel", "Esc");
    const move = keyHint(movement ?? "↑↓", "Move");
    const select = keyHint(primary("tui.select.confirm", "Enter"), "Select");
    const extra = this.options.hints ?? [];
    if (this.searchMode)
      return framedKeyHints(
        ["Type to filter", move, select, ...extra],
        [this.searchCancel()],
        inner,
      );
    const pages = `${key("tui.select.pageUp", "PgUp")}/${key("tui.select.pageDown", "PgDn")}`;
    return framedKeyHintBar(
      {
        hints: [move, select, keyHint("/", "Filter"), ...extra],
        more: [
          keyHint("j/k", "Move"),
          keyHint(`${pages}/C-u/C-d`, "Page"),
          keyHint("gg/G", "Ends"),
          keyHint("l", "Select"),
        ],
        exit: "nested",
        exitKey: cancel.key,
        exitAliases: [...cancel.aliases, "h", "q"],
      },
      this.alternateHelp,
      inner,
    );
  }

  // The query is set off by color alone; the highlight stays on the row Enter would select.
  private inputLines(width: number): string[] {
    return Arr.map(this.input.render(Math.max(1, width)), (line) =>
      this.options.theme.fg("accent", line),
    );
  }

  private compactBody(
    bodyHeight: number,
    width: number,
    activeNotice: string | undefined,
  ): string[] {
    const theme = this.options.theme;
    const noticeLine = activeNotice
      ? theme.fg("warning", clipToWidth(activeNotice, width, "…"))
      : undefined;
    const inputLine = this.searchMode ? this.inputLines(width)[0] : undefined;
    if (bodyHeight === 1) {
      const single = inputLine ?? noticeLine;
      if (single) return [single];
      this.resizeList(1);
      return this.renderList(width).slice(0, 1);
    }
    if (bodyHeight <= 1) return [];
    const compactHeader = [
      ...(inputLine ? [inputLine] : []),
      ...(noticeLine ? [noticeLine] : []),
      ...(bodyHeight > 3 ? [theme.fg("accent", theme.bold(this.options.title))] : []),
    ].slice(0, bodyHeight - 1);
    const listRows = Math.max(1, bodyHeight - compactHeader.length);
    this.resizeList(listRows);
    return [...compactHeader, ...this.renderList(width).slice(0, listRows)];
  }

  // A short title and subtitle share one line when both fit it whole.
  private headingLines(width: number): string[] {
    const theme = this.options.theme;
    const { title, subtitle } = this.options;
    const titleLine = theme.fg("accent", theme.bold(title));
    if (!subtitle) return [titleLine];
    if (
      visibleWidth(`${title}${INLINE_SEPARATOR}${subtitle}`) <=
      Math.min(width, SHARED_HEADING_WIDTH)
    )
      return [`${titleLine}${theme.fg("dim", `${INLINE_SEPARATOR}${subtitle}`)}`];
    return [titleLine, theme.fg("dim", clipToWidth(subtitle, width, "…"))];
  }

  private fullBody(bodyHeight: number, width: number, activeNotice: string | undefined): string[] {
    const theme = this.options.theme;
    const limitedWrap = (value: string, maximumLines: number): ReadonlyArray<string> => {
      const lines = wrapTextWithAnsi(value, Math.max(1, width));
      if (lines.length <= maximumLines) return lines;
      const shown = lines.slice(0, maximumLines);
      shown[maximumLines - 1] = `${clipToWidth(shown[maximumLines - 1] ?? "", width - 1, "")}…`;
      return shown;
    };
    const noticeLines = activeNotice
      ? Arr.map(limitedWrap(activeNotice, 2), (line) => theme.fg("warning", line))
      : [];
    // The footer carries the search keys; the body shows only the query.
    const searchLines = this.searchMode ? this.inputLines(width) : [];
    const header = [...this.headingLines(width), ...noticeLines, ...searchLines, ""];
    const desiredListHeight = Math.max(1, bodyHeight - header.length);
    this.resizeList(desiredListHeight);
    return [...header, ...this.renderList(width).slice(0, desiredListHeight)];
  }

  /**
   * The page without a frame: heading, notice, query, and list for a pane `width` columns wide
   * (its text width, inside any gutters) and `height` rows tall. Short panes drop the subtitle and
   * spacing first. Put `keyHints` in the host's border.
   */
  renderBody(width: number, height: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const safeHeight = Math.max(0, Math.floor(height));
    if (safeWidth === 0 || safeHeight === 0) return [];
    const activeNotice = this.feedback ?? this.options.notice;
    return safeHeight < COMPACT_BELOW
      ? this.compactBody(safeHeight, safeWidth, activeNotice)
      : this.fullBody(safeHeight, safeWidth, activeNotice);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    if (safeWidth < 4)
      return Array.from({ length: height }, () => Fn.pipe(" ", Str.repeat(safeWidth)));
    const inner = safeWidth - 2;
    const textWidth = Math.max(1, inner - 2 * FRAME_GUTTER);
    const title = clipToWidth(` ${this.options.breadcrumb} `, inner, "");
    const frame = listDetailFrame(this.options.theme, "list");
    const footer = this.keyHints(inner);
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
            // Text keeps a one-column gutter on each side of the frame.
            framedGutter(this.renderBody(textWidth, bodyHeight), inner),
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
