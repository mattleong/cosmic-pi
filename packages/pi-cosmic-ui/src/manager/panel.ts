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
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { lastIndexOfFrom } from "pi-cosmic-core/text-scan";
import {
  framedDivider,
  framedFill,
  framedScreen,
  listDetailFrame,
  type ListDetailFrame,
} from "./list-detail-shell.ts";
import { clipToWidth, joinInline } from "./chrome.ts";
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
 * Splits a plain path wider than `width` after its last `/` that fits, so `…/agent/` and
 * `code-previews.json` wrap as units. A segment without a `/` keeps the default hard break.
 */
const pathSegments = (word: string, width: number): ReadonlyArray<string> => {
  const segments: string[] = [];
  let rest = word;
  while (visibleWidth(rest) > width) {
    const slash = lastIndexOfFrom(rest, "/", width - 1);
    if (slash <= 0) break;
    segments.push(Fn.pipe(rest, Str.slice(0, slash + 1)));
    rest = Fn.pipe(rest, Str.slice(slash + 1));
  }
  return [...segments, rest];
};

const breakLongPaths = (line: string, width: number): string =>
  Fn.pipe(line, Str.includes(ESCAPE))
    ? line
    : Arr.join(
        Arr.map(Str.split(line, " "), (word) =>
          visibleWidth(word) > width && Fn.pipe(word, Str.includes("/"))
            ? Arr.join(pathSegments(word, width), "\n")
            : word,
        ),
        " ",
      );

/** Wraps one line, indenting continuation rows beneath the line's own indentation. */
export const wrapWithHangingIndent = (line: string, width: number): ReadonlyArray<string> => {
  const safeWidth = Math.max(1, Math.floor(width));
  if (visibleWidth(line) <= safeWidth) return [line];
  const hang = Math.min(leadingSpaces(line) + HANGING_INDENT, Math.max(0, safeWidth - 1));
  const indent = Fn.pipe(" ", Str.repeat(hang));
  const wrapWidth = Math.max(1, safeWidth - hang);
  // Wrapping at the continuation width keeps every row, including the first, within bounds.
  return Arr.map(wrapTextWithAnsi(breakLongPaths(line, wrapWidth), wrapWidth), (part, index) =>
    index === 0 ? part : `${indent}${Str.trimStart(part)}`,
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
