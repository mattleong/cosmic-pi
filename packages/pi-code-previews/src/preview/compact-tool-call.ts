import type { Theme } from "@earendil-works/pi-coding-agent";
import { layoutCompactRow, type CompactRowInput } from "./compact-row";
import { renderCompactChildren } from "./compact-children";
import { renderCompactIssues } from "./compact-issues";
import { compactQuoteClipped, renderCompactAffordance, renderCompactQuote } from "./compact-quote";

/**
 * A collapsed compact call: its row, issues, quote, and children, then `▸ label · C-o Expand` when
 * expansion reveals more (`expandLabel`), unless a clipped quote already ends in its own or the
 * affordance reveals only a subject the row shows whole (`expandsSubjectOnly`).
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
  const { row, subjectComplete } = layoutCompactRow(input, theme, width);
  const { compactSubject, expandsSubjectOnly, subject } = input.summary;
  const subjectShown =
    expandsSubjectOnly === true &&
    subjectComplete &&
    (compactSubject === undefined || compactSubject === subject);
  return [
    row,
    ...renderCompactIssues(input.summary.issues, theme, width),
    ...quoted,
    ...renderCompactChildren(input.summary.children, theme, width, {
      animationFrame: input.animationFrame,
      timingEnabled: input.timingEnabled,
    }),
    ...(clipped || subjectShown ? [] : renderCompactAffordance(input.expandLabel, theme, width)),
  ];
}
