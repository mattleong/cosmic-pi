import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { escapeControlChars } from "pi-code-previews";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { clipToWidth, type ManagerStatusColor } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";

/** Wrapped rows of an agent's words that a collapsed view shows before its expansion affordance. */
export const COLLAPSED_AGENT_TEXT_ROWS = 10;

const pad = (width: number): string => Fn.pipe(" ", Str.repeat(width));

/**
 * How far a message body indents its words: none beneath a collapsed compact row, which the message
 * shell already indents like the row's issues, and two columns below a preview heading.
 */
export const bodyIndent = (options: {
  readonly expanded: boolean;
  readonly collapsedStyle: "compact" | "preview";
}): number => (options.collapsedStyle === "compact" && !options.expanded ? 0 : 2);

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

interface AgentTextOptions {
  readonly expanded: boolean;
  readonly indent?: number | undefined;
  readonly color?: "toolOutput" | "muted" | "dim" | undefined;
  /** Rows a collapsed view keeps; omitted rows become one expansion affordance. */
  readonly rows?: number | undefined;
}

/**
 * Words an agent wrote, wrapped to `width` with their line breaks, indented. A collapsed view keeps
 * about ten rows and ends with the shared expansion affordance; an expanded view keeps all of it.
 */
export const agentTextLines = (
  text: string | undefined,
  width: number,
  theme: Pick<Theme, "fg">,
  options: AgentTextOptions,
): string[] => {
  const indent = Math.min(options.indent ?? 2, Math.max(0, width - 1));
  const inner = Math.max(1, width - indent);
  const color = options.color ?? "toolOutput";
  const rows = Arr.flatMap(Str.split(agentText(text), "\n"), (line) =>
    line === "" ? [""] : wrapTextWithAnsi(theme.fg(color, line), inner),
  );
  if (rows.length === 1 && rows[0] === "") return [];
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

/** One agent in a block list: its name and state, then the words it wrote or a short note. */
export interface AgentTextBlock {
  readonly glyph: string;
  readonly tone: ManagerStatusColor;
  readonly name: string;
  /** A short muted state or event, shown only when it departs from the expected. */
  readonly status?: string | undefined;
  readonly text?: string | undefined;
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
      ...agentTextLines(block.text, safeWidth, theme, { expanded }),
      ...Arr.flatMap(block.notes ?? [], (note) =>
        indentedLines(theme.fg("muted", sanitizeTerminalLine(note)), safeWidth),
      ),
    ];
  });
};

/** A dim expanded-only section of technical facts, one wrapped line each; leading spaces nest a fact. */
export const detailsSectionLines = (
  lines: ReadonlyArray<string>,
  width: number,
  theme: Pick<Theme, "fg">,
  label = "Details",
): string[] => {
  const facts = Arr.filter(lines, (line) => Str.isNonEmpty(Str.trim(line)));
  if (facts.length === 0) return [];
  const safeWidth = Math.max(1, width);
  return [
    clipToWidth(theme.fg("muted", label), safeWidth),
    ...Arr.flatMap(facts, (line) => {
      const nested = line.length - Str.trimStart(line).length;
      return indentedLines(theme.fg("dim", sanitizeTerminalLine(line)), safeWidth, 2 + nested);
    }),
  ];
};
