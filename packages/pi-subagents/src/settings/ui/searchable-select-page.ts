import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type Component,
  type SelectItem,
  SelectList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface SearchableSelectPageChoice<A> {
  readonly value: string;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly payload: A;
}

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

  private resolveListHeight(): number {
    return Math.max(1, this.options.getHeight() - 10);
  }

  private buildList(): SelectList {
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
    if (!this.query && this.options.current) {
      const index = this.filtered.findIndex((choice) => choice.value === this.options.current);
      if (index >= 0) list.setSelectedIndex(index);
    }
    return list;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.options.cancel();
    else if (matchesKey(data, Key.enter)) {
      const selected = this.list.getSelectedItem();
      const choice = selected
        ? this.options.choices.find((entry) => entry.value === selected.value)
        : undefined;
      if (choice) this.options.select(choice.payload);
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.list.handleInput(data);
    } else {
      this.input.handleInput(data);
      const next = this.input.getValue();
      if (next !== this.query) {
        this.query = next;
        this.list = this.buildList();
      }
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    if (safeWidth < 4) return Array.from({ length: height }, () => " ".repeat(safeWidth));
    const nextListHeight = this.resolveListHeight();
    if (nextListHeight !== this.listHeight) {
      this.listHeight = nextListHeight;
      this.list = this.buildList();
    }

    const theme = this.options.theme;
    const inner = safeWidth - 2;
    const body: string[] = [
      theme.fg("accent", theme.bold(this.options.title)),
      theme.fg("dim", this.options.subtitle),
      ...(this.options.notice ? [theme.fg("warning", this.options.notice)] : [""]),
      theme.fg("dim", "Search:"),
      ...this.input.render(Math.max(1, inner)),
      "",
    ];
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

    const title = truncateToWidth(` ${this.options.breadcrumb} `, inner, "");
    const top = `${theme.fg("borderAccent", "╭")}${title}${theme.fg(
      "borderAccent",
      `${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`,
    )}`;
    const footer = truncateToWidth(
      "Type to search · ↑↓ navigate · Enter select · Esc back",
      inner,
      "",
    );
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
