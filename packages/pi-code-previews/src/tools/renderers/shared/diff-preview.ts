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
    lineNumbers?: boolean | undefined;
  },
): string {
  const syntaxHighlightSkipped = shouldSkipHighlight(diff);
  const lineNumbers = options.lineNumbers ?? true;
  let text = syntaxHighlightSkipped
    ? renderPlainDiff(diff, theme, limit, lineNumbers)
    : renderSyntaxHighlightedDiff(diff, lang, theme, limit, options.invalidate, lineNumbers);
  if (options.totalLines > limit)
    text += showingFooter(theme, limit, options.totalLines, options.hiddenLineNoun);
  if (syntaxHighlightSkipped) text += previewFooter(theme, options.skipHighlightLabel);
  return text;
}

/** A routine note where a size or complexity guard skipped a diff. */
export function diffSkippedNote(theme: Theme, guard: "size" | "complexity"): string {
  return theme.fg(
    "muted",
    `diff skipped: ${guard === "size" ? "large content" : "complex rewrite"}`,
  );
}

export function diffPreviewLineLimit(
  totalLines: number,
  expanded: boolean,
  collapsedLines: CodePreviewSettings["editCollapsedLines"],
): number {
  return expanded || collapsedLines === "all" ? totalLines : collapsedLines;
}
