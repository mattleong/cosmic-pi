import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import {
  authoredTextLines,
  expandedBody,
  expandedDetails,
  expandedSection,
} from "pi-code-previews";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { indexOfFrom, lastIndexOfFrom } from "pi-cosmic-core/text-scan";
import { clipToWidth, wrapFacts, type ManagerStatusColor } from "pi-cosmic-ui/manager";
import { composeToolComponent } from "pi-cosmic-ui/tool";

/**
 * Words an agent wrote, laid out by Code Previews' authored text: wrapped to the width with their
 * line breaks and indented, a collapsed view keeping about ten rows before its expansion affordance.
 */
export {
  authoredTextLines as agentTextLines,
  COLLAPSED_AUTHORED_TEXT_ROWS as COLLAPSED_AGENT_TEXT_ROWS,
} from "pi-code-previews";

/** `width` columns of spaces. */
export const pad = (width: number): string => Fn.pipe(" ", Str.repeat(width));

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

/** One already-styled line wrapped to `width`, every row indented by `indent` columns. */
export const indentedLines = (line: string, width: number, indent = 2): string[] => {
  const shift = Math.min(indent, Math.max(0, width - 1));
  return Arr.map(
    wrapTextWithAnsi(line, Math.max(1, width - shift)),
    (row) => `${pad(shift)}${row}`,
  );
};

/** Plain text in a row of facts, the theme color it renders in (none keeps the default), and its weight. */
export type FactSpan = readonly [text: string, color?: ThemeColor, weight?: "bold"];

type FactTheme = Pick<Theme, "fg" | "bold">;

const FACT_SEPARATOR = " · ";
const FACT_BREAKS = [FACT_SEPARATOR, " "] as const;
/** How `wrapFacts` leads a row that starts a new fact: the separator's `·`, then a space. */
const FACT_MARKER = "·";
const FACT_LEAD = `${FACT_MARKER} `;

/** The color of the span holding `offset`. */
const colorAt = (spans: ReadonlyArray<FactSpan>, offset: number): ThemeColor | undefined => {
  let end = 0;
  for (const [text, color] of spans) {
    end += text.length;
    if (offset < end) return color;
  }
  return undefined;
};

/** The spans' text from `start` to `end`, each part in its span's color. */
const paintRange = (
  spans: ReadonlyArray<FactSpan>,
  start: number,
  end: number,
  theme: FactTheme,
): string => {
  let offset = 0;
  let painted = "";
  for (const [text, color, weight] of spans) {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + text.length);
    if (from < to) {
      const part = Fn.pipe(text, Str.slice(from - offset, to - offset));
      const weighted = weight === "bold" ? theme.bold(part) : part;
      painted += color === undefined ? weighted : theme.fg(color, weighted);
    }
    offset += text.length;
  }
  return painted;
};

/**
 * `·`-joined facts wrapped beneath `indent` between whole facts, so no row ends with `·` or `→`;
 * continuation rows hang `hang` columns further in. Each span keeps its color on whichever row it
 * lands.
 */
export const hangingLines = (
  spans: ReadonlyArray<FactSpan>,
  width: number,
  theme: FactTheme,
  options: FactRowOptions = {},
): string[] => {
  const shift = Math.min(options.indent ?? 0, Math.max(0, width - 1));
  const text = Arr.join(
    Arr.map(spans, ([part]) => part),
    "",
  );
  let at = 0;
  const rows = wrapFacts(text, Math.max(1, width - shift), pad(options.hang ?? 2));
  return Arr.map(rows, (row, index) => {
    // Each row is the next stretch of the facts after its hanging indent; the break between rows
    // drops only a space or a separator, whose `·` may lead the row as the new fact's marker.
    const trimmed = index === 0 ? row : Str.trimStart(row);
    const lead = pad(shift + row.length - trimmed.length);
    const led = Fn.pipe(trimmed, Str.slice(FACT_LEAD.length));
    if (
      index > 0 &&
      Fn.pipe(trimmed, Str.startsWith(FACT_LEAD)) &&
      Fn.pipe(text, Str.startsWith(FACT_SEPARATOR, at)) &&
      Fn.pipe(text, Str.startsWith(led, at + FACT_SEPARATOR.length))
    ) {
      const color = colorAt(spans, at + 1);
      at += FACT_SEPARATOR.length;
      const painted = paintRange(spans, at, at + led.length, theme);
      at += led.length;
      return `${lead}${color === undefined ? FACT_MARKER : theme.fg(color, FACT_MARKER)} ${painted}`;
    }
    const body = trimmed;
    for (const gap of FACT_BREAKS)
      if (Fn.pipe(text, Str.startsWith(gap, at)) && !Fn.pipe(text, Str.startsWith(body, at))) {
        at += gap.length;
        break;
      }
    if (!Fn.pipe(text, Str.startsWith(body, at))) return `${lead}${body}`;
    const painted = paintRange(spans, at, at + body.length, theme);
    at += body.length;
    return `${lead}${painted}`;
  });
};

export interface FactRowOptions {
  /** Columns every row starts in. */
  readonly indent?: number | undefined;
  /** Columns continuation rows start beyond `indent`; two by default. */
  readonly hang?: number | undefined;
  /**
   * Whether a collapsed row of facts alone keeps whole facts, ending `· …`, rather than clipping
   * inside the last one, as a row ending in free text such as a task does.
   */
  readonly wholeFacts?: boolean | undefined;
}

const CLIPPED_FACTS = `${FACT_SEPARATOR}…`;

/** A collapsed row's trailing words keep at least this many columns, or the row ends `· …`. */
const MIN_TRAILING_COLUMNS = 8;
/** A word-boundary cut keeps at least this share of the trailing fact's room, as `endElide` does. */
const WORD_CUT_SHARE = 0.6;

/**
 * Where a row too wide for `room` ends, leaving a column for `…`: after the last whole word of its
 * trailing fact, or before that fact (`facts`) when only a sliver of it would fit.
 */
interface TrailingCut {
  readonly end: number;
  /** The row keeps whole facts up to `end` and ends `· …`. */
  readonly facts: boolean;
}

const trailingCut = (text: string, room: number): TrailingCut => {
  const slice = (start: number, end: number) => Fn.pipe(text, Str.slice(start, end));
  let fit = Math.min(text.length, room - 1);
  while (fit > 0 && visibleWidth(slice(0, fit)) > room - 1) fit--;
  const separator = lastIndexOfFrom(text, FACT_SEPARATOR, fit - FACT_SEPARATOR.length);
  const factStart = separator === -1 ? 0 : separator + FACT_SEPARATOR.length;
  if (separator > 0 && visibleWidth(slice(factStart, fit)) < MIN_TRAILING_COLUMNS)
    return { end: separator, facts: true };
  const wholeWord = fit === text.length || slice(fit, fit + 1) === " ";
  const space = wholeWord ? fit : lastIndexOfFrom(text, " ", fit - 1);
  let end =
    space > factStart && space - factStart >= WORD_CUT_SHARE * (fit - factStart) ? space : fit;
  while (end > 1 && slice(end - 1, end) === " ") end--;
  return { end, facts: false };
};

/**
 * One collapsed row of facts within `width`. With `wholeFacts`, a row too wide keeps the whole facts
 * that fit and ends `· …`, as settings values do, so it never cuts inside a fact; only a first fact
 * too wide on its own is clipped.
 */
const clippedFactRow = (
  spans: ReadonlyArray<FactSpan>,
  width: number,
  theme: FactTheme,
  { indent = 0, wholeFacts = false }: FactRowOptions,
): string => {
  const lead = pad(indent);
  const text = Arr.join(
    Arr.map(spans, ([part]) => part),
    "",
  );
  const room = width - indent;
  let kept = -1;
  if (wholeFacts && visibleWidth(text) > room)
    for (
      let at = indexOfFrom(text, FACT_SEPARATOR, 1);
      at !== -1 && visibleWidth(`${Fn.pipe(text, Str.slice(0, at))}${CLIPPED_FACTS}`) <= room;
      at = indexOfFrom(text, FACT_SEPARATOR, at + FACT_SEPARATOR.length)
    )
      kept = at;
  if (kept === -1 && visibleWidth(text) > room && room > 1) {
    const cut = trailingCut(text, room);
    if (cut.facts) kept = cut.end;
    else {
      const color = colorAt(spans, cut.end - 1);
      return `${lead}${paintRange(spans, 0, cut.end, theme)}${color === undefined ? "…" : theme.fg(color, "…")}`;
    }
  }
  if (kept === -1)
    return clipToWidth(`${lead}${paintRange(spans, 0, Number.POSITIVE_INFINITY, theme)}`, width);
  const color = colorAt(spans, kept);
  return `${lead}${paintRange(spans, 0, kept, theme)}${color === undefined ? CLIPPED_FACTS : theme.fg(color, CLIPPED_FACTS)}`;
};

/**
 * A row of facts: expanded, wrapped by {@link hangingLines} so every fact shows; collapsed, one row
 * clipped to `width`.
 */
export const factRowLines = (
  spans: ReadonlyArray<FactSpan>,
  width: number,
  theme: FactTheme,
  expanded: boolean,
  options: FactRowOptions = {},
): string[] =>
  expanded
    ? hangingLines(spans, width, theme, options)
    : [clippedFactRow(spans, width, theme, options)];

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
    const heading = factRowLines(
      [
        [block.glyph, block.tone],
        [" "],
        [sanitizeTerminalLine(block.name), "toolTitle", "bold"],
        [block.status ? ` · ${sanitizeTerminalLine(block.status)}` : "", "muted"],
      ],
      safeWidth,
      theme,
      expanded,
    );
    return [
      ...heading,
      ...authoredTextLines(block.text, safeWidth, theme, { expanded, verbatim: block.verbatim }),
      ...Arr.flatMap(block.notes ?? [], (note) =>
        indentedLines(theme.fg("muted", sanitizeTerminalLine(note)), safeWidth),
      ),
    ];
  });
};
