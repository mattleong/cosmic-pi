import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
  escapeControlChars,
  expandedBody,
  expandedDetails,
  expandedSection,
} from "pi-code-previews";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth, type ManagerStatusColor } from "pi-cosmic-ui/manager";
import { composeToolComponent, renderExpansionAffordance } from "pi-cosmic-ui/tool";

/** Wrapped rows of an agent's words that a collapsed view shows before its expansion affordance. */
export const COLLAPSED_AGENT_TEXT_ROWS = 10;

const pad = (width: number): string => Fn.pipe(" ", Str.repeat(width));

/**
 * How far a message body indents its words: none beneath a collapsed compact row, which the message
 * shell already indents like the row's issues, nor when expanded, where {@link indentedBody} indents
 * the whole body; two columns below a collapsed preview heading.
 */
export const bodyIndent = (options: {
  readonly expanded: boolean;
  readonly collapsedStyle: "compact" | "preview";
}): number => (options.collapsedStyle === "preview" && !options.expanded ? 2 : 0);

/**
 * An expanded body drawn from the heading's column, indented beneath it as every workspace tool's
 * is: its words two columns in, and its `Details` label there with the facts two further.
 */
export const indentedBody = (theme: Pick<Theme, "fg">, content: Component): Component =>
  expandedSection(theme, undefined, content);

/**
 * An expanded body drawn from the heading's column: its rows indented beneath the heading, then
 * the dim `Details` section of technical facts. Leading spaces nest a fact beneath the one before.
 */
export const expandedRowsBody = (
  theme: Pick<Theme, "fg">,
  rows: (width: number) => string[],
  facts: ReadonlyArray<string> = [],
): Component =>
  expandedBody(
    indentedBody(
      theme,
      composeToolComponent((width) => rows(Math.max(1, width))),
    ),
    expandedFactDetails(theme, facts),
  );

/** A Details fact on one line, its nesting kept. */
const sanitizeFact = (fact: string): string => {
  const nested = fact.length - Str.trimStart(fact).length;
  return `${pad(nested)}${sanitizeTerminalLine(fact)}`;
};

/** The dim `Details` section at the heading's column, each fact on one line before wrapping. */
export const expandedFactDetails = (
  theme: Pick<Theme, "fg">,
  facts: ReadonlyArray<string>,
): Component => expandedDetails(theme, Arr.map(facts, sanitizeFact));

/** Agent-written text with its controls made visible and without surrounding blank lines. */
export const agentText = (text: string | undefined): string =>
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

type AgentTextColor = "toolOutput" | "muted" | "dim";

interface AgentTextOptions {
  readonly expanded: boolean;
  readonly indent?: number | undefined;
  readonly color?: AgentTextColor | undefined;
  /** Rows a collapsed view keeps; omitted rows become one expansion affordance. */
  readonly rows?: number | undefined;
  /** Diagnostics such as stack traces keep their exact lines instead of rendering as markdown. */
  readonly verbatim?: boolean | undefined;
}

// Rows re-render on every frame; recent markdown layouts are reused until the theme changes.
const MARKDOWN_CACHE_ENTRIES = 64;
const markdownRows = new WeakMap<object, Map<string, ReadonlyArray<string>>>();

type AgentTextTheme = Pick<Theme, "fg" | "bold">;

const plain = (text: string) => text;

// Pi's markdown colors, drawn with the row's own theme rather than the host's global one.
const markdownTheme = (theme: AgentTextTheme): MarkdownTheme => {
  return {
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
  };
};

/** Agent-written markdown laid out as Pi lays out assistant text, inline code styled. */
const markdownLines = (
  text: string,
  width: number,
  theme: AgentTextTheme,
  color: AgentTextColor,
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
 * Words an agent wrote, wrapped to `width` with their line breaks, indented. A collapsed view keeps
 * about ten rows and ends with the shared expansion affordance; an expanded view keeps all of it.
 */
export const agentTextLines = (
  text: string | undefined,
  width: number,
  theme: AgentTextTheme,
  options: AgentTextOptions,
): string[] => {
  const indent = Math.min(options.indent ?? 2, Math.max(0, width - 1));
  const inner = Math.max(1, width - indent);
  const color = options.color ?? "toolOutput";
  const words = agentText(text);
  if (words === "") return [];
  const rows = options.verbatim
    ? Arr.flatMap(Str.split(words, "\n"), (line) =>
        line === "" ? [""] : wrapTextWithAnsi(theme.fg(color, line), inner),
      )
    : Arr.map(markdownLines(words, inner, theme, color), (row) => Str.trimEnd(row));
  if (rows.length === 0 || (rows.length === 1 && rows[0] === "")) return [];
  const limit = options.rows ?? COLLAPSED_AGENT_TEXT_ROWS;
  const prefix = pad(indent);
  // One hidden row costs as much as its affordance, so it is shown instead.
  if (options.expanded || rows.length <= limit + 1)
    return Arr.map(rows, (row) => (row === "" ? "" : `${prefix}${row}`));
  return [
    ...Arr.map(rows.slice(0, limit), (row) => (row === "" ? "" : `${prefix}${row}`)),
    clipToWidth(
      `${prefix}${renderExpansionAffordance(`${rows.length - limit} more lines`, false, theme)}`,
      width,
    ),
  ];
};

/** One already-styled line wrapped to `width`, every row indented by `indent` columns. */
export const indentedLines = (line: string, width: number, indent = 2): string[] => {
  const shift = Math.min(indent, Math.max(0, width - 1));
  return Arr.map(
    wrapTextWithAnsi(line, Math.max(1, width - shift)),
    (row) => `${pad(shift)}${row}`,
  );
};

/** A line wrapped beneath `indent`, its continuation rows hanging two columns further in. */
export const hangingLines = (line: string, width: number, indent = 0): string[] => {
  const shift = Math.min(indent, Math.max(0, width - 1));
  const hang = Math.min(shift + 2, Math.max(0, width - 1));
  const [first = "", ...rest] = wrapTextWithAnsi(line, Math.max(1, width - hang));
  return [`${pad(shift)}${first}`, ...Arr.map(rest, (row) => `${pad(hang)}${row}`)];
};

/** One agent in a block list: its name and state, then the words it wrote or a short note. */
export interface AgentTextBlock {
  readonly glyph: string;
  readonly tone: ManagerStatusColor;
  readonly name: string;
  /** A short muted state or event, shown only when it departs from the expected. */
  readonly status?: string | undefined;
  readonly text?: string | undefined;
  /** The text is a diagnostic shown exactly, not markdown. */
  readonly verbatim?: boolean | undefined;
  /** Short muted lines after the text, such as a report saved in full elsewhere. */
  readonly notes?: ReadonlyArray<string> | undefined;
}

/** Agent blocks as reports, questions, and messages share them: `✓ name · status`, then its words. */
export const agentTextBlockLines = (
  blocks: ReadonlyArray<AgentTextBlock>,
  width: number,
  theme: Pick<Theme, "fg" | "bold">,
  expanded: boolean,
): string[] => {
  const safeWidth = Math.max(1, width);
  return Arr.flatMap(blocks, (block) => {
    const status = block.status
      ? theme.fg("muted", ` · ${sanitizeTerminalLine(block.status)}`)
      : "";
    const heading = `${theme.fg(block.tone, block.glyph)} ${theme.fg("toolTitle", theme.bold(sanitizeTerminalLine(block.name)))}${status}`;
    return [
      clipToWidth(heading, safeWidth),
      ...agentTextLines(block.text, safeWidth, theme, { expanded, verbatim: block.verbatim }),
      ...Arr.flatMap(block.notes ?? [], (note) =>
        indentedLines(theme.fg("muted", sanitizeTerminalLine(note)), safeWidth),
      ),
    ];
  });
};
