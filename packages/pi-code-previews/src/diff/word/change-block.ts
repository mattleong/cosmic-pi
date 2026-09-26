import {
  changedLineTokens,
  normalizedChangedContent,
  type IndexedChangedLine,
} from "./changed-line";
import { matchChangedLines, type ChangedLinePair } from "./line-matching";
import type { DiffWordEmphasis } from "../../config/schema";
import {
  isAddedDiffLine,
  isRemovedDiffLine,
  type AddedDiffLine,
  type ParsedDiffLine,
  type RemovedDiffLine,
} from "../parse";
import { changedRangesWithConfidence } from "./emphasis";
import type { ConfidentWordChangeRanges } from "./types";

type ChangedLineBlockAnalysis = {
  removed: Array<IndexedChangedLine<RemovedDiffLine>>;
  added: Array<IndexedChangedLine<AddedDiffLine>>;
  pairs: ChangedLinePair[];
  ranges: ChangedLineRangePair[];
};

type ChangedLineRangePair = {
  pair: ChangedLinePair;
  ranges: ConfidentWordChangeRanges;
};

export function analyzeChangedLineBlock(
  block: ParsedDiffLine[],
  wordEmphasis: DiffWordEmphasis,
): ChangedLineBlockAnalysis {
  const removed: Array<IndexedChangedLine<RemovedDiffLine>> = [];
  const added: Array<IndexedChangedLine<AddedDiffLine>> = [];
  for (const [index, line] of block.entries()) {
    if (isRemovedDiffLine(line)) removed.push({ index, line });
    else if (isAddedDiffLine(line)) added.push({ index, line });
  }
  const removedByIndex = new Map(removed.map((line) => [line.index, line]));
  const addedByIndex = new Map(added.map((line) => [line.index, line]));
  const pairs = matchChangedLines(removed, added);
  const ranges: ChangedLineRangePair[] = [];

  for (const pair of pairs) {
    const removedLine = removedByIndex.get(pair.removedIndex);
    const addedLine = addedByIndex.get(pair.addedIndex);
    if (!removedLine || !addedLine) continue;
    ranges.push({
      pair,
      ranges: changedRangesWithConfidence(
        normalizedChangedContent(removedLine),
        normalizedChangedContent(addedLine),
        wordEmphasis,
        changedLineTokens(removedLine),
        changedLineTokens(addedLine),
      ),
    });
  }

  return { removed, added, pairs, ranges };
}
