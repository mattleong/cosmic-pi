import type { Theme } from "@earendil-works/pi-coding-agent";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import { authoredTextLines } from "./authored-text";

const INDENT = 2;

/**
 * Words someone wrote beneath a collapsed compact row, indented as its issues are and rendered as
 * markdown with their line breaks. About ten wrapped rows show; the rest become one expansion
 * affordance.
 */
export function renderCompactQuote(
  quote: string | undefined,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
): string[] {
  return authoredTextLines(quote, width, theme, {
    expanded: false,
    indent: width > INDENT * 2 ? INDENT : 0,
  });
}

/** Whether the collapsed quote ends in its own expansion affordance because rows are hidden. */
export function compactQuoteClipped(
  quote: string | undefined,
  theme: Pick<Theme, "fg" | "bold">,
  width: number,
  shown: number,
): boolean {
  const indent = width > INDENT * 2 ? INDENT : 0;
  return authoredTextLines(quote, width, theme, { expanded: true, indent }).length > shown;
}

/** The collapsed row's `▸ label · C-o Expand`, indented as its issues are. */
export function renderCompactAffordance(
  label: string | undefined,
  theme: Pick<Theme, "fg">,
  width: number,
): string[] {
  if (label === undefined || width <= 0) return [];
  const indent = width > INDENT * 2 ? "  " : "";
  return [clipToWidth(`${indent}${renderExpansionAffordance(label, false, theme)}`, width)];
}
