import {
  changedLineTokens,
  normalizedChangedContent,
  type IndexedChangedLine,
} from "./changed-line";
import { matchChangedLines, type ChangedLinePair } from "./line-matching";
import type { DiffWordEmphasis } from "../../config/schema";
import {
  changedDiffBlocks,
  isAddedDiffLine,
  isRemovedDiffLine,
  type AddedDiffLine,
  type ParsedDiffLine,
  type RemovedDiffLine,
} from "../parse";
import { changedRangesWithConfidence, shouldEmphasizeChangedPair } from "./emphasis";
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

/** Pairs one run of changed rows; pair indexes are relative to the run. */
export function analyzeChangedLineBlock(
  block: readonly (ParsedDiffLine | null)[],
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

/** Line pairs confident enough to emphasize, indexed across the whole diff. */
export function* emphasizedChangedPairs(
  lines: readonly (ParsedDiffLine | null)[],
  wordEmphasis: DiffWordEmphasis,
): Generator<{ removedIndex: number; addedIndex: number; ranges: ConfidentWordChangeRanges }> {
  if (wordEmphasis === "off") return;
  for (const [start, end] of changedDiffBlocks(lines)) {
    for (const { pair, ranges } of analyzeChangedLineBlock(lines.slice(start, end), wordEmphasis)
      .ranges) {
      if (!shouldEmphasizeChangedPair(ranges, pair.confidence)) continue;
      yield {
        removedIndex: start + pair.removedIndex,
        addedIndex: start + pair.addedIndex,
        ranges,
      };
    }
  }
}
