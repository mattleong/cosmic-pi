import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderPlainDiff, renderSyntaxHighlightedDiff } from "../../../diff/render";
import { previewFooter, showingFooter } from "../../../preview/format";
import type { CodePreviewSettings } from "../../../config/schema";
import { shouldSkipHighlight } from "../../../syntax/render";
import { paintLineCounts } from "pi-cosmic-ui/tool";
import { diffCountLabel } from "../../builtin-result-detail";

export function formatDiffPreview(
  diff: string,
  lang: string | undefined,
  theme: Theme,
  limit: number,
  options: {
    totalLines: number;
    invalidate?: (() => void) | undefined;
    proposed?: boolean;
    highlight?: boolean;
  },
): string {
  const syntaxHighlightSkipped = shouldSkipHighlight(diff);
  const lineNumbers = options.proposed !== true;
  const noun = lineNumbers ? "diff" : "proposed diff";
  let text =
    syntaxHighlightSkipped || options.highlight === false
      ? renderPlainDiff(diff, theme, limit, lineNumbers)
      : renderSyntaxHighlightedDiff(diff, lang, theme, limit, options.invalidate, lineNumbers);
  if (options.totalLines > limit)
    text += showingFooter(theme, options.totalLines - limit, `${noun} line`);
  if (syntaxHighlightSkipped)
    text += previewFooter(theme, `Syntax highlighting skipped for large ${noun}`);
  return text;
}

/** `+4 −2` in the muted tone of the summary around it, its nonzero counts in the diff's colours. */
export function diffCounts(theme: Theme, counts: { additions: number; removals: number }): string {
  return paintLineCounts(theme, diffCountLabel(counts), "muted");
}

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
