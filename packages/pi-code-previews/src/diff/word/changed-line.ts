import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { expandPreviewTabs } from "../../shared/preview-tabs";
import { escapeControlChars } from "../../shared/terminal-text";
import { wordEmphasisTokens, type WordEmphasisToken } from "./tokens";

export type IndexedChangedLine<T extends AddedDiffLine | RemovedDiffLine> = {
  index: number;
  line: T;
  normalizedContent?: string;
  tokens?: WordEmphasisToken[];
  similarityTokenValues?: string[];
  similarityFeatureValues?: string[];
};

export type ChangedLinePositions = {
  removed: Map<number, number>;
  added: Map<number, number>;
};

export function indexedChangedLine<T extends AddedDiffLine | RemovedDiffLine>(
  index: number,
  line: T,
): IndexedChangedLine<T> {
  return { index, line };
}

export function normalizedChangedContent(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): string {
  // Compute ranges against the same normalized text that Shiki/fallback rendering displays.
  // Otherwise tabs or escaped control chars shift the emphasis range by multiple cells.
  return (line.normalizedContent ??= normalizeDiffContent(line.line.content));
}

export function changedLineTokens(
  line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>,
): WordEmphasisToken[] {
  return (line.tokens ??= wordEmphasisTokens(normalizedChangedContent(line)));
}

export function changedLinePositions(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePositions {
  return {
    removed: new Map(removed.map((line, index) => [line.index, index])),
    added: new Map(added.map((line, index) => [line.index, index])),
  };
}

export function changedLineAt<T extends AddedDiffLine | RemovedDiffLine>(
  lines: Array<IndexedChangedLine<T>>,
  index: number,
): IndexedChangedLine<T> {
  const line = lines[index];
  if (line === undefined) throw new RangeError(`Missing changed line ${index}`);
  return line;
}

function normalizeDiffContent(content: string): string {
  return escapeControlChars(expandPreviewTabs(content));
}
