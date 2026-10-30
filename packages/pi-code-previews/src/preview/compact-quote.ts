import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { escapeControlChars } from "../shared/terminal-text";

/** Wrapped rows of quoted words a collapsed compact row shows before its expansion affordance. */
export const COMPACT_QUOTE_ROWS = 10;

const INDENT = "  ";

/**
 * Words someone wrote beneath a collapsed compact row, indented as its issues are, with their line
 * breaks. About ten wrapped rows show; the rest become one expansion affordance.
 */
export function renderCompactQuote(
  quote: string | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
): string[] {
  const lines = Fn.pipe(
    quote ?? "",
    Str.replaceAll("\r\n", "\n"),
    Str.replaceAll("\t", "  "),
    escapeControlChars,
    Str.split("\n"),
    Arr.map((line) => Str.trimEnd(line)),
    Arr.dropWhile((line) => line === ""),
    Arr.reverse,
    Arr.dropWhile((line) => line === ""),
    Arr.reverse,
  );
  if (lines.length === 0 || width <= 0) return [];
  const indent = width > INDENT.length * 2 ? INDENT : "";
  const inner = Math.max(1, width - indent.length);
  const rows = Arr.flatMap(lines, (line) =>
    line === "" ? [""] : wrapTextWithAnsi(theme.fg("toolOutput", line), inner),
  );
  const indented = (row: string) => (row === "" ? row : `${indent}${row}`);
  // One hidden row costs as much as its affordance, so it is shown instead.
  if (rows.length <= COMPACT_QUOTE_ROWS + 1) return Arr.map(rows, indented);
  return [
    ...Arr.map(rows.slice(0, COMPACT_QUOTE_ROWS), indented),
    clipToWidth(
      `${indent}${renderExpansionAffordance(`${rows.length - COMPACT_QUOTE_ROWS} more lines`, false, theme)}`,
      width,
    ),
  ];
}
