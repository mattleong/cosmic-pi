import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderCompactRow, type CompactRowInput } from "./compact-row";
import { renderCompactChildren } from "./compact-children";
import { renderCompactIssues } from "./compact-issues";
import { compactQuoteClipped, renderCompactAffordance, renderCompactQuote } from "./compact-quote";

/**
 * A collapsed compact call: its row, issues, quote, and children, then `▸ label · C-o Expand` when
 * expansion reveals more (`expandLabel`), unless a clipped quote already ends in its own.
 */
export function renderCompactToolCall(
  input: CompactRowInput & { readonly expandLabel?: string | undefined },
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { quote } = input.summary;
  const quoted = renderCompactQuote(quote, theme, width);
  const clipped = quoted.length > 0 && compactQuoteClipped(quote, theme, width, quoted.length);
  return [
    renderCompactRow(input, theme, width),
    ...renderCompactIssues(input.summary.issues, theme, width),
    ...quoted,
    ...renderCompactChildren(input.summary.children, theme, width, {
      animationFrame: input.animationFrame,
      timingEnabled: input.timingEnabled,
    }),
    ...(clipped ? [] : renderCompactAffordance(input.expandLabel, theme, width)),
  ];
}
