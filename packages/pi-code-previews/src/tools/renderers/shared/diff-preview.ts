import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderPlainDiff, renderSyntaxHighlightedDiff } from "../../../diff/render";
import { previewFooter, showingFooter } from "../../../preview/format";
import type { CodePreviewSettings } from "../../../config/schema";
import { shouldSkipHighlight } from "../../../syntax/render";

export function formatDiffPreview(
  diff: string,
  lang: string | undefined,
  theme: Theme,
  limit: number,
  options: {
    totalLines: number;
    hiddenLineNoun: string;
    skipHighlightLabel: string;
    invalidate?: (() => void) | undefined;
  },
): string {
  const syntaxHighlightSkipped = shouldSkipHighlight(diff);
  let text = syntaxHighlightSkipped
    ? renderPlainDiff(diff, theme, limit)
    : renderSyntaxHighlightedDiff(diff, lang, theme, limit, options.invalidate);
  if (options.totalLines > limit)
    text += showingFooter(theme, limit, options.totalLines, options.hiddenLineNoun);
  if (syntaxHighlightSkipped) text += previewFooter(theme, options.skipHighlightLabel);
  return text;
}

export function diffPreviewLineLimit(
  totalLines: number,
  expanded: boolean,
  collapsedLines: CodePreviewSettings["editCollapsedLines"],
): number {
  return expanded || collapsedLines === "all" ? totalLines : collapsedLines;
}
