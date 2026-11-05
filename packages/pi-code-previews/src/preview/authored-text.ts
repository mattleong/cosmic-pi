import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { escapeControlChars } from "../shared/terminal-text";
import { wrapPlainText } from "../shared/text-wrap";

/** Wrapped rows of authored words a collapsed view shows before its expansion affordance. */
export const COLLAPSED_AUTHORED_TEXT_ROWS = 10;

export type AuthoredTextTheme = Pick<Theme, "fg" | "bold">;

export type AuthoredTextColor = "toolOutput" | "muted" | "dim";

export interface AuthoredTextOptions {
  /** Expanded text is complete; collapsed text keeps `rows` rows and an expansion affordance. */
  readonly expanded: boolean;
  /** Columns every row indents; defaults to 2. */
  readonly indent?: number | undefined;
  readonly color?: AuthoredTextColor | undefined;
  /** Rows a collapsed view keeps; defaults to `COLLAPSED_AUTHORED_TEXT_ROWS`. */
  readonly rows?: number | undefined;
  /** Diagnostics such as stack traces keep their exact lines instead of rendering as markdown. */
  readonly verbatim?: boolean | undefined;
}

/** Authored text with its controls made visible and without surrounding blank lines. */
export const authoredText = (text: string | undefined): string =>
  Fn.pipe(
    text ?? "",
    Str.replaceAll("\r\n", "\n"),
    Str.replaceAll("\t", "  "),
    escapeControlChars,
    Str.split("\n"),
    Arr.map((line) => Str.trimEnd(line)),
    Arr.dropWhile((line) => line === ""),
    Arr.reverse,
    Arr.dropWhile((line) => line === ""),
    Arr.reverse,
    Arr.join("\n"),
  );

// Rows re-render on every frame; recent markdown layouts are reused until the theme changes.
const MARKDOWN_CACHE_ENTRIES = 64;
const markdownRows = new WeakMap<object, Map<string, ReadonlyArray<string>>>();

const plain = (text: string) => text;

// Pi's markdown colors, drawn with the row's own theme rather than the host's global one.
const markdownTheme = (theme: AuthoredTextTheme): MarkdownTheme => ({
  heading: (text) => theme.fg("mdHeading", theme.bold(text)),
  link: (text) => theme.fg("mdLink", text),
  linkUrl: (text) => theme.fg("mdLinkUrl", text),
  code: (text) => theme.fg("mdCode", text),
  codeBlock: (text) => theme.fg("mdCodeBlock", text),
  codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
  quote: (text) => theme.fg("mdQuote", text),
  quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
  hr: (text) => theme.fg("mdHr", text),
  listBullet: (text) => theme.fg("mdListBullet", text),
  bold: (text) => theme.bold(text),
  italic: plain,
  strikethrough: plain,
  underline: plain,
});

const markdownLines = (
  text: string,
  width: number,
  theme: AuthoredTextTheme,
  color: AuthoredTextColor,
): ReadonlyArray<string> => {
  const cache = markdownRows.get(theme) ?? new Map<string, ReadonlyArray<string>>();
  markdownRows.set(theme, cache);
  const key = `${color}\u0000${width}\u0000${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const rows = new Markdown(text, 0, 0, markdownTheme(theme), {
    color: (value) => theme.fg(color, value),
  }).render(width);
  if (cache.size >= MARKDOWN_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) cache.delete(oldest.value);
  }
  cache.set(key, rows);
  return rows;
};

/**
 * Words an agent or session wrote, laid out as Pi lays out assistant markdown, wrapped to `width`
 * with their line breaks and indented. A collapsed view keeps about ten rows and ends with the
 * shared expansion affordance; an expanded view keeps all of it.
 */
export const authoredTextLines = (
  text: string | undefined,
  width: number,
  theme: AuthoredTextTheme,
  options: AuthoredTextOptions,
): string[] => {
  if (width <= 0) return [];
  const indent = Math.min(options.indent ?? 2, Math.max(0, width - 1));
  const inner = Math.max(1, width - indent);
  const color = options.color ?? "toolOutput";
  const words = authoredText(text);
  if (words === "") return [];
  const rows = options.verbatim
    ? Arr.flatMap(Str.split(words, "\n"), (line) =>
        line === "" ? [""] : Arr.map(wrapPlainText(line, inner), (row) => theme.fg(color, row)),
      )
    : Arr.map(markdownLines(words, inner, theme, color), (row) => Str.trimEnd(row));
  if (rows.length === 0 || (rows.length === 1 && rows[0] === "")) return [];
  const limit = options.rows ?? COLLAPSED_AUTHORED_TEXT_ROWS;
  const prefix = Fn.pipe(" ", Str.repeat(indent));
  const indented = (row: string) => (row === "" ? "" : `${prefix}${row}`);
  // One hidden row costs as much as its affordance, so it is shown instead.
  if (options.expanded || rows.length <= limit + 1) return Arr.map(rows, indented);
  return [
    ...Arr.map(rows.slice(0, limit), indented),
    clipToWidth(
      `${prefix}${renderExpansionAffordance(`${rows.length - limit} more lines`, false, theme)}`,
      width,
    ),
  ];
};
