import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  type Component,
  type Focusable,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "./chrome.ts";
import { padListDetailRow } from "./list-detail.ts";
import { isListMotion, nextListMotionIndex } from "./list-navigation.ts";
import { FullScreenKeymap, pageSteps, type FullScreenSelectionKeybindingId } from "./keymap.ts";
import { fullScreenSettingsHint } from "./settings-adapter.ts";

export interface SearchableSelectPageChoice<A> {
  readonly value: string;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly payload: A;
  readonly enabled?: boolean | undefined;
  readonly disabledReason?: string | undefined;
}

export type SettingsSelectKeybindingId = FullScreenSelectionKeybindingId;

export interface SearchableSelectHostOptions {
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly matchesKeybinding?:
    | ((data: string, id: SettingsSelectKeybindingId) => boolean)
    | undefined;
  readonly keybindingLabel?:
    | ((id: SettingsSelectKeybindingId, fallback: string) => string)
    | undefined;
}

export interface SearchableSelectPageOptions<A> extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly breadcrumb: string;
  readonly title: string;
  readonly subtitle: string;
  readonly choices: ReadonlyArray<SearchableSelectPageChoice<A>>;
  readonly current?: string | undefined;
  readonly notice?: string | undefined;
  readonly emptyText?: string | undefined;
  readonly initialQuery?: string | undefined;
  readonly initialSearchMode?: boolean | undefined;
  readonly select: (value: A) => void;
  readonly cancel: () => void;
}

export interface SearchableSelectSearchState {
  readonly query: string;
  readonly active: boolean;
}

/** Responsive full-page fuzzy-search input and dropdown shared by settings selectors. */
export class SearchableSelectPage<A> implements Component, Focusable {
  private readonly input = new Input();
  private readonly options: SearchableSelectPageOptions<A>;
  private query: string;
  private filtered: ReadonlyArray<SearchableSelectPageChoice<A>>;
  private list: SelectList;
  private listHeight: number;
  private feedback: string | undefined;
  private searchMode: boolean;
  private selectedIdentity: string | undefined;
  private alternateHelp = false;
  private _focused = false;
  private readonly keymap = new FullScreenKeymap();

  constructor(options: SearchableSelectPageOptions<A>) {
    this.options = options;
    this.query = options.initialQuery ?? "";
    this.filtered = options.choices;
    this.listHeight = this.resolveListHeight();
    this.searchMode = options.initialSearchMode ?? Boolean(options.initialQuery);
    this.selectedIdentity = options.current ?? options.choices[0]?.value;
    if (this.query) this.input.setValue(this.query);
    this.list = this.buildList();
    this.input.focused = false;
  }

  get focused(): boolean {
    return this._focused;
  }

  /** Stable selected identity exposed for pure wrappers such as the scoped model picker. */
  get selectedValue(): string | undefined {
    return this.selectedIdentity;
  }

  /** Current filter state exposed so a wrapper can rebuild without losing search context. */
  get searchState(): SearchableSelectSearchState {
    return { query: this.query, active: this.searchMode };
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value && this.searchMode;
  }

  private resolveListHeight(extraReservedRows = 0): number {
    const height = this.options.getHeight();
    return Math.max(1, height < 10 ? height - 3 : height - 10 - extraReservedRows);
  }

  private resizeList(height: number): void {
    const next = Math.max(1, height);
    if (next === this.listHeight) return;
    this.listHeight = next;
    this.list = this.buildList();
  }

  private selectedChoice(): SearchableSelectPageChoice<A> | undefined {
    const selected = this.list?.getSelectedItem();
    return selected ? this.filtered.find((entry) => entry.value === selected.value) : undefined;
  }

  private buildList(): SelectList {
    this.filtered = fuzzyFilter(
      [...this.options.choices],
      this.query,
      (choice) => choice.searchText,
    );
    const theme = this.options.theme;
    const list = new SelectList(
      this.filtered.map((choice) =>
        this.alternateHelp ? choice.item : { value: choice.item.value, label: choice.item.label },
      ),
      this.listHeight,
      {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (_text: string) =>
          theme.fg("warning", `  ${this.options.emptyText ?? "No matching options"}`),
      },
    );
    const preferredIndex = this.selectedIdentity
      ? this.filtered.findIndex((choice) => choice.value === this.selectedIdentity)
      : -1;
    const currentIndex =
      preferredIndex < 0 && this.selectedIdentity === undefined && this.options.current
        ? this.filtered.findIndex((choice) => choice.value === this.options.current)
        : -1;
    const selectedIndex = preferredIndex >= 0 ? preferredIndex : currentIndex;
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    return list;
  }

  /** Non-motion keymap actions shared by search and navigation modes. */
  private handleSelectAction(action: string): void {
    switch (action) {
      case "cancel":
        if (this.searchMode) this.clearSearchAndExit();
        else this.options.cancel();
        break;
      case "quit":
      case "back":
        this.options.cancel();
        break;
      case "confirm":
      case "forward": {
        const choice = this.selectedChoice();
        if (choice?.enabled !== false) {
          if (choice) {
            this.selectedIdentity = choice.value;
            this.options.select(choice.payload);
          } else
            this.feedback = `${this.options.emptyText ?? "No matching options"}; change the search or go back.`;
        } else
          this.feedback =
            choice.disabledReason ?? `${choice.item.label || choice.value} is unavailable.`;
        break;
      }
      case "search":
        this.setSearchMode(true);
        break;
      case "help": {
        this.alternateHelp = !this.alternateHelp;
        this.list = this.buildList();
        break;
      }
      case "pending-first":
      case "previous-pane":
      case "next-pane":
        break;
    }
  }

  handleInput(data: string): void {
    const resolution = this.keymap.resolve(data, {
      mode: this.searchMode ? "search" : "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
    });
    if (resolution?._tag === "Action") {
      const currentChoice = this.selectedChoice();
      const current = currentChoice ? this.filtered.indexOf(currentChoice) : 0;
      const length = this.filtered.length;
      if (isListMotion(resolution.action)) {
        if (length > 0) {
          this.list.setSelectedIndex(
            nextListMotionIndex(
              resolution.action,
              current,
              length,
              pageSteps(this.listHeight - 1),
              true,
            ),
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
        this.list = this.buildList();
      }
      this.options.requestRender();
    }
  }

  private clearSearchAndExit(): void {
    this.setSearchMode(false);
    if (!this.query) return;
    this.query = "";
    this.input.setValue("");
    this.list = this.buildList();
  }

  private setSearchMode(active: boolean): void {
    if (this.searchMode === active) return;
    this.searchMode = active;
    this.keymap.resetChord();
    this.input.focused = this._focused && active;
    this.feedback = undefined;
  }

  private footer(inner: number): string {
    const key = (id: SettingsSelectKeybindingId, fallback: string): string =>
      this.options.keybindingLabel?.(id, fallback) || fallback;
    const confirm = key("tui.select.confirm", "Enter");
    const cancel = key("tui.select.cancel", "Esc");
    const configuredNavigation = this.options.keybindingLabel
      ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
      : undefined;
    const normalNavigation = configuredNavigation ? `j/k · ${configuredNavigation}` : "j/k";
    return this.searchMode
      ? renderResponsiveManagerFooter(inner, [
          ["Type to filter · ↑/↓ Navigate", `${confirm} Select · ${cancel} Done`],
          [`${confirm} Select`, `${cancel} Done`],
        ])
      : this.alternateHelp
        ? renderResponsiveManagerFooter(inner, [
            [
              `${normalNavigation} Navigate · C-u/d Half · PgUp/PgDn Page · gg/G Ends`,
              `/ Filter · l/${confirm} Select · h/q/${cancel} Back · ? Less`,
            ],
            [`${normalNavigation} · C-u/d · PgUp/PgDn · gg/G`, `? Less · q Back`],
          ])
        : renderResponsiveManagerFooter(inner, [
            [
              `${normalNavigation} Navigate · ${confirm} Select`,
              `/ Filter · ? More · ${cancel} Back`,
            ],
            [`${confirm} Select`, `? · ${cancel} Back`],
          ]);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    if (safeWidth < 4) return Array.from({ length: height }, () => " ".repeat(safeWidth));
    const theme = this.options.theme;
    const inner = safeWidth - 2;
    const title = truncateToWidth(` ${this.options.breadcrumb} `, inner, "");
    const top = `${theme.fg("borderAccent", "╭")}${title}${theme.fg(
      "borderAccent",
      `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`,
    )}`;
    if (height === 1) return [truncateToWidth(top, safeWidth, "")];
    const activeNotice = this.feedback ?? this.options.notice;
    const body: string[] = [];
    if (height < 10) {
      const bodyHeight = Math.max(0, height - 2);
      const noticeLine = activeNotice
        ? theme.fg("warning", truncateToWidth(activeNotice, inner, "…"))
        : undefined;
      const inputLine = this.searchMode
        ? this.input.render(Math.max(1, inner)).slice(0, 1)[0]
        : undefined;
      if (bodyHeight === 1) {
        const single = inputLine ?? noticeLine;
        if (single) body.push(single);
        else {
          this.resizeList(1);
          body.push(...this.list.render(inner).slice(0, 1));
        }
      } else if (bodyHeight > 1) {
        const compactHeader = [
          ...(inputLine ? [inputLine] : []),
          ...(noticeLine ? [noticeLine] : []),
          ...(bodyHeight > 3 ? [theme.fg("accent", theme.bold(this.options.title))] : []),
        ].slice(0, bodyHeight - 1);
        const listRows = Math.max(1, bodyHeight - compactHeader.length);
        this.resizeList(listRows);
        body.push(...compactHeader, ...this.list.render(inner).slice(0, listRows));
      }
    } else {
      const limitedWrap = (value: string, maximumLines: number): ReadonlyArray<string> => {
        const lines = wrapTextWithAnsi(value, Math.max(1, inner));
        if (lines.length <= maximumLines) return lines;
        const shown = lines.slice(0, maximumLines);
        shown[maximumLines - 1] = truncateToWidth(`${shown[maximumLines - 1] ?? ""}…`, inner, "");
        return shown;
      };
      const bodyHeight = Math.max(0, height - 2);
      const noticeLines = activeNotice
        ? limitedWrap(activeNotice, 2).map((line) => theme.fg("warning", line))
        : [];
      const subtitleLines = limitedWrap(this.options.subtitle, 1).map((line) =>
        theme.fg("dim", line),
      );
      const searchLines = this.searchMode
        ? [
            theme.fg("dim", fullScreenSettingsHint({ searching: true })),
            ...this.input.render(Math.max(1, inner)),
          ]
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
      body.push(...header, ...this.list.render(inner).slice(0, desiredListHeight));
    }

    const footer = this.footer(inner);
    const bottom = `${theme.fg("borderAccent", "╰")}${theme.fg(
      "borderAccent",
      "─".repeat(Math.max(0, inner - visibleWidth(footer))),
    )}${footer}${theme.fg("borderAccent", "╯")}`;
    const bodyHeight = Math.max(0, height - 2);
    const framed = body
      .slice(0, bodyHeight)
      .map(
        (line) =>
          `${theme.fg("borderAccent", "│")}${padListDetailRow(line, inner)}${theme.fg("borderAccent", "│")}`,
      );
    while (framed.length < bodyHeight)
      framed.push(
        `${theme.fg("borderAccent", "│")}${" ".repeat(inner)}${theme.fg("borderAccent", "│")}`,
      );
    return [truncateToWidth(top, safeWidth, ""), ...framed, truncateToWidth(bottom, safeWidth, "")];
  }

  invalidate(): void {
    this.input.invalidate();
    this.list.invalidate();
  }
}
