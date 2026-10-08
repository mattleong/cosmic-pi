import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { expandPreviewTabs } from "../../shared/helpers";
import { escapeControlChars } from "../../shared/terminal-text";
import { wordEmphasisTokens, type WordEmphasisToken } from "./tokens";

export type IndexedChangedLine<T extends AddedDiffLine | RemovedDiffLine> = {
  index: number;
  line: T;
  normalizedContent?: string;
  tokens?: WordEmphasisToken[];
};

export function normalizedChangedContent(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): string {
  // Compute ranges against the same normalized text that Shiki/fallback rendering displays.
  // Otherwise tabs or escaped control chars shift the emphasis range by multiple cells.
  return (line.normalizedContent ??= escapeControlChars(expandPreviewTabs(line.line.content)));
}

export function changedLineTokens(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): WordEmphasisToken[] {
  return (line.tokens ??= wordEmphasisTokens(normalizedChangedContent(line)));
}
