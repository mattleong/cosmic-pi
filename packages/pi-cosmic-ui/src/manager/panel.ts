import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import {
  framedDivider,
  framedFill,
  framedScreen,
  listDetailFrame,
  type ListDetailFrame,
} from "./list-detail-shell.ts";
import { clipToWidth, INLINE_SEPARATOR, joinInline, wrapWords } from "./chrome.ts";
import { FullScreenKeymap, pageSteps, type FullScreenAction } from "./keymap.ts";
import {
  framedKeyHintBar,
  keyHint,
  keyHintRows,
  type KeyHintBar,
  type SurfaceExitLevel,
} from "./key-labels.ts";

interface TextPanelOptions {
  readonly title: string;
  readonly theme: Pick<Theme, "fg" | "bold">;
  readonly lines: ReadonlyArray<string>;
  readonly done: () => void;
  /** `top` (default) labels Esc as Close; `nested` labels it Back. */
  readonly exit?: Exclude<SurfaceExitLevel, "decision"> | undefined;
  /** Rows available to the whole panel, including its frame; omit to show every line. */
  readonly maxHeight?: (() => number) | undefined;
}

const HANGING_INDENT = 2;

const leadingSpaces = (line: string): number => line.length - Fn.pipe(line, Str.trimStart).length;

const ESCAPE = "\u001b";

/**
 * Wraps plain `·`-joined facts between whole facts before it breaks inside one, so a row breaks at
 * `… compact` / `· changes apply after /reload`. A fact that starts a row leads with `· `, and its
 * own continuation hangs past it.
 */
const wrapPlainFacts = (text: string, firstWidth: number, restWidth: number): string[] => {
  const rows: string[] = [];
  let current = "";
  const limit = () => (rows.length === 0 ? firstWidth : restWidth);
  let leading = true;
  for (const fact of Str.split(text, INLINE_SEPARATOR)) {
    if (current) {
      const candidate = `${current}${INLINE_SEPARATOR}${fact}`;
      if (visibleWidth(candidate) <= limit()) {
        current = candidate;
        continue;
      }
      rows.push(current);
      current = "";
    }
    // A led fact's own continuation hangs past its `· `, so it never reads as another fact.
    const under = leading ? "" : "  ";
    const parts = Arr.map(
      wrapWords(`${leading ? "" : "· "}${fact}`, limit(), Math.max(1, restWidth - under.length)),
      (part, index) => (index === 0 ? part : `${under}${part}`),
    );
    leading = false;
    rows.push(...parts.slice(0, -1));
    current = Option.getOrElse(Arr.last(parts), () => "");
  }
  if (current || rows.length === 0) rows.push(current);
  return rows;
};

/**
 * Wraps one line, indenting continuation rows beneath the line's own indentation. Plain text wraps
 * between `·`-joined facts first, then like `wrapFacts`, so a label keeps a readable part of a wide
 * name beside it and the name breaks after `/`, `-`, `_`, or `.` before it breaks mid-word; styled
 * text wraps at word boundaries.
 */
export const wrapWithHangingIndent = (line: string, width: number): ReadonlyArray<string> => {
  const safeWidth = Math.max(1, Math.floor(width));
  if (visibleWidth(line) <= safeWidth) return [line];
  const lead = Math.min(leadingSpaces(line), Math.max(0, safeWidth - 1));
  const hang = Math.min(leadingSpaces(line) + HANGING_INDENT, Math.max(0, safeWidth - 1));
  const indent = Fn.pipe(" ", Str.repeat(hang));
  const wrapWidth = Math.max(1, safeWidth - hang);
  if (Fn.pipe(line, Str.includes(ESCAPE)))
    // Wrapping at the continuation width keeps every row, including the first, within bounds.
    return Arr.map(wrapTextWithAnsi(line, wrapWidth), (part, index) =>
      index === 0 ? part : `${indent}${Str.trimStart(part)}`,
    );
  const leading = Fn.pipe(" ", Str.repeat(lead));
  return Arr.map(
    wrapPlainFacts(Str.trimStart(line), Math.max(1, safeWidth - lead), wrapWidth),
    (part, index) => (index === 0 ? `${leading}${part}` : `${indent}${part}`),
  );
};

type PanelMotion = "up" | "down" | "page-up" | "page-down" | "first" | "last";

const PANEL_MOTIONS: Partial<Record<FullScreenAction, PanelMotion>> = {
  up: "up",
  down: "down",
  "half-page-up": "page-up",
  "full-page-up": "page-up",
  "half-page-down": "page-down",
  "full-page-down": "page-down",
  first: "first",
  last: "last",
};

const CLOSE_ACTIONS: ReadonlySet<FullScreenAction> = new Set(["cancel", "quit", "back"]);

/** A framed, read-only text panel that wraps long lines, scrolls, and closes with Esc, C-c, or q. */
export class TextPanelComponent implements Component {
  private readonly options: TextPanelOptions;
  private readonly frame: ListDetailFrame;
  private readonly keymap = new FullScreenKeymap();
  private scroll = 0;
  private helpExpanded = false;
  private bodyHeight = 0;
  private rowCount = 0;

  constructor(options: TextPanelOptions) {
    this.options = options;
    this.frame = listDetailFrame(options.theme);
  }

  private get maxScroll(): number {
    return Math.max(0, this.rowCount - this.bodyHeight);
  }

  // The panel closes on C-c and q as well as Esc; expanded help names them in the exit pair.
  private hintBar(scrollable: boolean): KeyHintBar {
    const exit = this.options.exit ?? "top";
    const exitAliases = ["C-c", "q"];
    if (!scrollable) return { hints: [], exit, exitAliases };
    return {
      hints: [keyHint("↑↓", "Scroll")],
      more: [keyHint("j/k", "Scroll"), keyHint("PgUp/PgDn", "Page"), keyHint("gg/G", "Ends")],
      exit,
      exitAliases,
    };
  }

  /**
   * Inside a settings surface the panel keeps its hint in its own border, and the surface's `?`
   * drives its expanded help.
   */
  settingsHint(expanded: boolean): string {
    this.helpExpanded = expanded;
    return "";
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth === 0) return [];
    const { theme, title } = this.options;
    const inner = Math.max(0, safeWidth - 2);
    const text = Math.max(1, inner - 2);
    const rows = Arr.flatMap(this.options.lines, (line) =>
      Arr.map(wrapWithHangingIndent(line, text), (row) => ` ${clipToWidth(row, text, "…")}`),
    );
    const limit = this.options.maxHeight?.();
    const bodyLimit =
      Predicate.isNumber(limit) && Number.isFinite(limit)
        ? Math.max(1, Math.floor(limit) - 2)
        : Number.POSITIVE_INFINITY;
    const scrollable = rows.length > bodyLimit;
    // The border keeps the exit and the help toggle; pairs that don't fit wrap above it.
    const hints = framedKeyHintBar(this.hintBar(scrollable), this.helpExpanded, inner);
    const help = keyHintRows(hints.overflow, inner, (row) => theme.fg("dim", row));
    const helpHeight = help.length ? help.length + 1 : 0;
    this.rowCount = rows.length;
    this.bodyHeight = Math.max(1, Math.min(rows.length, bodyLimit - helpHeight));
    this.scroll = Math.min(this.scroll, this.maxScroll);
    const visible = Arr.take(Arr.drop(rows, this.scroll), this.bodyHeight);
    const position = scrollable
      ? `${this.scroll + 1}–${this.scroll + visible.length} of ${rows.length}`
      : undefined;
    return framedScreen(this.frame, {
      width: safeWidth,
      height: this.bodyHeight + helpHeight + 2,
      top: clipToWidth(
        ` ${joinInline([theme.bold(title), position && theme.fg("dim", position)])} `,
        inner,
        "…",
      ),
      bottom: hints.border ? theme.fg("dim", hints.border) : "",
      body: (height) =>
        help.length
          ? [
              ...framedFill(this.frame, visible, height - helpHeight, inner),
              framedDivider(this.frame, inner),
              ...framedFill(this.frame, help, help.length, inner),
            ]
          : framedFill(this.frame, visible, height, inner),
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) return this.options.done();
    const resolution = this.keymap.resolve(data, { mode: "navigation" });
    if (!Predicate.isTagged(resolution, "Action")) return;
    const { action } = resolution;
    if (CLOSE_ACTIONS.has(action)) return this.options.done();
    if (action === "help") {
      this.helpExpanded = !this.helpExpanded;
      return;
    }
    const motion = PANEL_MOTIONS[action];
    if (!motion) return;
    const { page, half } = pageSteps(this.bodyHeight);
    this.scroll = Math.max(
      0,
      Math.min(
        this.maxScroll,
        Match.value(motion).pipe(
          Match.when("up", () => this.scroll - 1),
          Match.when("down", () => this.scroll + 1),
          Match.when("page-up", () => this.scroll - (action === "half-page-up" ? half : page)),
          Match.when("page-down", () => this.scroll + (action === "half-page-down" ? half : page)),
          Match.when("first", () => 0),
          Match.when("last", () => this.maxScroll),
          Match.exhaustive,
        ),
      ),
    );
  }

  invalidate(): void {}
}
