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
  return (line.normalizedContent ??= escapeControlChars(expandPreviewTabs(line.line.content)));
}

export function changedLineTokens(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): WordEmphasisToken[] {
  return (line.tokens ??= wordEmphasisTokens(normalizedChangedContent(line)));
}
