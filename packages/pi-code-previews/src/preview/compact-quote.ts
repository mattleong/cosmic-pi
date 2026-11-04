import type { Theme } from "@earendil-works/pi-coding-agent";
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
