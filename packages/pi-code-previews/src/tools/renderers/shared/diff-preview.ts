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
    invalidate?: (() => void) | undefined;
    /** A proposed snippet's rows have no file positions, so they carry only +/- markers. */
    proposed?: boolean;
  },
): string {
  const syntaxHighlightSkipped = shouldSkipHighlight(diff);
  const lineNumbers = options.proposed !== true;
  const noun = lineNumbers ? "diff" : "proposed diff";
  let text = syntaxHighlightSkipped
    ? renderPlainDiff(diff, theme, limit, lineNumbers)
    : renderSyntaxHighlightedDiff(diff, lang, theme, limit, options.invalidate, lineNumbers);
  if (options.totalLines > limit)
    text += showingFooter(theme, limit, options.totalLines, `${noun} lines`);
  if (syntaxHighlightSkipped)
    text += previewFooter(theme, `Syntax highlighting skipped for large ${noun}`);
  return text;
}

/** Added and removed line counts, as `+N -M`. */
export function diffCounts(theme: Theme, counts: { additions: number; removals: number }): string {
  return `${theme.fg("success", `+${counts.additions}`)} ${theme.fg("error", `-${counts.removals}`)}`;
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
