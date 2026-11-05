import type { Theme } from "@earendil-works/pi-coding-agent";
import { layoutTaggedCompactRow, type CompactRowInput } from "./compact-row";
import { renderCompactChildren } from "./compact-children";
import { renderCompactIssues } from "./compact-issues";
import { compactQuoteClipped, renderCompactQuote } from "./compact-quote";

/**
 * The tag a collapsed compact call's row draws: `expandLabel`, unless a clipped quote already ends
 * in its own affordance.
 */
export function compactRowTag(
  summary: CompactRowInput["summary"],
  expandLabel: string | undefined,
  theme: Theme,
  width: number,
  quoted = renderCompactQuote(summary.quote, theme, width),
): string | undefined {
  const clipped =
    quoted.length > 0 && compactQuoteClipped(summary.quote, theme, width, quoted.length);
  return clipped ? undefined : expandLabel;
}

/**
 * A collapsed compact call: its row, issues, quote, and children. When expansion reveals more
 * (`expandLabel`), the row ends in its tag, `▸ label` or a bare `▸`, unless a clipped quote already
 * ends in its own affordance or the tag would reveal only a subject the row shows whole
 * (`expandsSubjectOnly`).
 */
export function renderCompactToolCall(
  input: CompactRowInput & { readonly expandLabel?: string | undefined },
  theme: Theme,
  width: number,
): string[] {
  if (width <= 0) return [];
  const quoted = renderCompactQuote(input.summary.quote, theme, width);
  const label = compactRowTag(input.summary, input.expandLabel, theme, width, quoted);
  const { row } = layoutTaggedCompactRow(input, theme, width, label);
  return [
    row,
    ...renderCompactIssues(input.summary.issues, theme, width),
    ...quoted,
    ...renderCompactChildren(input.summary.children, theme, width, {
      animationFrame: input.animationFrame,
      timingEnabled: input.timingEnabled,
    }),
  ];
}
