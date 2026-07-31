import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type Component,
  type KeyId,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";

export interface SearchableSelectPageChoice<A> {
  readonly value: string;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly payload: A;
}

export type SettingsSelectKeybindingId =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "tui.select.confirm"
  | "tui.select.cancel";

export interface SearchableSelectPageOptions<A> {
  readonly theme: Theme;
  readonly breadcrumb: string;
  readonly title: string;
  readonly subtitle: string;
  readonly choices: ReadonlyArray<SearchableSelectPageChoice<A>>;
  readonly current?: string | undefined;
  readonly notice?: string | undefined;
  readonly emptyText?: string | undefined;
  readonly initialQuery?: string | undefined;
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly matchesKeybinding?:
    | ((data: string, id: SettingsSelectKeybindingId) => boolean)
    | undefined;
  readonly keybindingLabel?:
    | ((id: SettingsSelectKeybindingId, fallback: string) => string)
    | undefined;
  readonly select: (value: A) => void;
  readonly cancel: () => void;
}

const padToWidth = (text: string, width: number): string => {
  const safeWidth = Math.max(0, width);
  const truncated = truncateToWidth(text, safeWidth, "");
  return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
};

/** Responsive full-page fuzzy-search input and dropdown shared by settings selectors. */
export class SearchableSelectPage<A> implements Component {
  private readonly input = new Input();
  private readonly options: SearchableSelectPageOptions<A>;
  private query: string;
  private filtered: ReadonlyArray<SearchableSelectPageChoice<A>>;
  private list: SelectList;
  private listHeight: number;
  private feedback: string | undefined;

  constructor(options: SearchableSelectPageOptions<A>) {
    this.options = options;
    this.query = options.initialQuery ?? "";
    this.filtered = options.choices;
    this.listHeight = this.resolveListHeight();
    if (this.query) this.input.setValue(this.query);
    this.list = this.buildList();
    this.input.focused = true;
  }

  get focused(): boolean {
    return this.input.focused;
  }

  set focused(value: boolean) {
    this.input.focused = value;
  }

  private resolveListHeight(extraReservedRows = 0): number {
    const height = this.options.getHeight();
    return Math.max(1, height < 10 ? height - 3 : height - 10 - extraReservedRows);
  }

  private resizeList(height: number): void {
    const next = Math.max(1, height);
    if (next === this.listHeight) return;
    const selected = this.selectedChoice();
    this.listHeight = next;
    this.list = this.buildList(selected);
  }

  private selectedChoice(): SearchableSelectPageChoice<A> | undefined {
    const selected = this.list?.getSelectedItem();
    return selected ? this.filtered.find((entry) => entry.item === selected) : undefined;
  }

  private buildList(preferred?: SearchableSelectPageChoice<A>): SelectList {
    this.filtered = fuzzyFilter(
      [...this.options.choices],
      this.query,
      (choice) => choice.searchText,
    );
    const theme = this.options.theme;
    const list = new SelectList(
      this.filtered.map((choice) => choice.item),
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
    const preferredIndex = preferred ? this.filtered.indexOf(preferred) : -1;
    const currentIndex = this.options.current
      ? this.filtered.findIndex((choice) => choice.value === this.options.current)
      : -1;
    const selectedIndex = preferredIndex >= 0 ? preferredIndex : currentIndex;
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    return list;
  }

  private matches(data: string, key: KeyId, id: SettingsSelectKeybindingId): boolean {
    return this.options.matchesKeybinding
      ? this.options.matchesKeybinding(data, id)
      : matchesKey(data, key);
  }

  handleInput(data: string): void {
    if (this.matches(data, Key.escape, "tui.select.cancel")) this.options.cancel();
    else if (this.matches(data, Key.enter, "tui.select.confirm")) {
      const choice = this.selectedChoice();
      if (choice) this.options.select(choice.payload);
      else
        this.feedback = `${this.options.emptyText ?? "No matching options"}; change the search or go back.`;
    } else {
      const up = this.matches(data, Key.up, "tui.select.up");
      const down = this.matches(data, Key.down, "tui.select.down");
      const pageUp = this.matches(data, Key.pageUp, "tui.select.pageUp");
      const pageDown = this.matches(data, Key.pageDown, "tui.select.pageDown");
      const home = matchesKey(data, Key.home);
      const end = matchesKey(data, Key.end);
      if (up || down || pageUp || pageDown || home || end) {
        const currentChoice = this.selectedChoice();
        const current = currentChoice ? this.filtered.indexOf(currentChoice) : 0;
        const length = this.filtered.length;
        if (length > 0) {
          const step = pageUp || pageDown ? Math.max(1, this.listHeight - 1) : 1;
          const next = home
            ? 0
            : end
              ? length - 1
              : pageUp
                ? Math.max(0, current - step)
                : pageDown
                  ? Math.min(length - 1, current + step)
                  : up
                    ? (current - 1 + length) % length
                    : (current + 1) % length;
          this.list.setSelectedIndex(next);
        }
        this.feedback = undefined;
        this.options.requestRender();
        return;
      }
      const selected = this.selectedChoice();
      this.input.handleInput(data);
      const next = this.input.getValue();
      if (next !== this.query) {
        this.query = next;
        this.feedback = undefined;
        this.list = this.buildList(selected);
      }
    }
    this.options.requestRender();
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
      const inputLine = this.input.render(Math.max(1, inner)).slice(0, 1);
      const noticeLine = activeNotice
        ? theme.fg("warning", truncateToWidth(activeNotice, inner, "…"))
        : undefined;
      const compactHeader =
        bodyHeight <= 0
          ? []
          : bodyHeight === 1
            ? noticeLine
              ? [noticeLine]
              : []
            : bodyHeight === 2
              ? noticeLine
                ? [noticeLine]
                : inputLine
              : noticeLine
                ? [...inputLine, noticeLine]
                : [theme.fg("accent", theme.bold(this.options.title)), ...inputLine];
      const listRows = Math.max(1, bodyHeight - compactHeader.length);
      this.resizeList(listRows);
      body.push(...compactHeader, ...this.list.render(inner).slice(0, listRows));
    } else {
      const limitedWrap = (value: string, maximumLines: number): ReadonlyArray<string> => {
        const lines = wrapTextWithAnsi(value, Math.max(1, inner));
        if (lines.length <= maximumLines) return lines;
        const shown = lines.slice(0, maximumLines);
        shown[maximumLines - 1] = truncateToWidth(`${shown[maximumLines - 1] ?? ""}…`, inner, "");
        return shown;
      };
      const bodyHeight = Math.max(0, height - 2);
      const metadataBudget = Math.max(1, bodyHeight - 7);
      const noticeLines = activeNotice
        ? limitedWrap(activeNotice, Math.min(3, metadataBudget)).map((line) =>
            theme.fg("warning", line),
          )
        : [];
      const subtitleBudget = Math.max(0, metadataBudget - noticeLines.length);
      const subtitleLines =
        subtitleBudget > 0
          ? limitedWrap(this.options.subtitle, Math.min(2, subtitleBudget)).map((line) =>
              theme.fg("dim", line),
            )
          : [];
      const inputLines = this.input.render(Math.max(1, inner));
      const header = [
        theme.fg("accent", theme.bold(this.options.title)),
        ...subtitleLines,
        ...noticeLines,
        theme.fg("dim", "Search:"),
        ...inputLines,
        "",
      ];
      const desiredListHeight = Math.max(1, bodyHeight - header.length - 2);
      this.resizeList(desiredListHeight);
      body.push(...header);
      const dropdownWidth = Math.max(0, inner - 2);
      const dropdownTitle = truncateToWidth(
        ` Options · ${this.filtered.length}/${this.options.choices.length} `,
        dropdownWidth,
        "",
      );
      body.push(
        `${theme.fg("borderMuted", "╭")}${dropdownTitle}${theme.fg(
          "borderMuted",
          "─".repeat(Math.max(0, inner - visibleWidth(dropdownTitle) - 2)),
        )}${theme.fg("borderMuted", "╮")}`,
      );
      for (const line of this.list.render(dropdownWidth))
        body.push(
          `${theme.fg("borderMuted", "│")}${padToWidth(line, dropdownWidth)}${theme.fg("borderMuted", "│")}`,
        );
      body.push(
        `${theme.fg("borderMuted", "╰")}${theme.fg("borderMuted", "─".repeat(dropdownWidth))}${theme.fg("borderMuted", "╯")}`,
      );
    }

    const key = (id: SettingsSelectKeybindingId, fallback: string): string =>
      this.options.keybindingLabel?.(id, fallback) || fallback;
    const navigation = this.options.keybindingLabel
      ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
      : "↑↓";
    const pages = `${key("tui.select.pageUp", "PgUp")}/${key("tui.select.pageDown", "PgDn")}`;
    const confirm = key("tui.select.confirm", "Enter");
    const cancel = key("tui.select.cancel", "Esc");
    const footer = renderResponsiveManagerFooter(inner, [
      [
        "Type to search",
        `${navigation} Navigate · ${pages} Page · Home/End`,
        `${confirm} Select · ${cancel} Back`,
      ],
      [`${navigation} Navigate · ${pages}`, `${confirm} Select`, `${cancel} Back`],
      [`${cancel} Back`, `${confirm} Select`],
    ]);
    const bottom = `${theme.fg("borderAccent", "╰")}${theme.fg(
      "borderAccent",
      "─".repeat(Math.max(0, inner - visibleWidth(footer))),
    )}${footer}${theme.fg("borderAccent", "╯")}`;
    const bodyHeight = Math.max(0, height - 2);
    const framed = body
      .slice(0, bodyHeight)
      .map(
        (line) =>
          `${theme.fg("borderAccent", "│")}${padToWidth(line, inner)}${theme.fg("borderAccent", "│")}`,
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
