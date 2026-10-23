import * as Arr from "effect/Array";
import {
  changedLineTokens,
  normalizedChangedContent,
  type IndexedChangedLine,
} from "./changed-line";
import { matchChangedLines, type ChangedLinePair } from "./line-matching";
import type { DiffWordEmphasis } from "../../config/schema";
import {
  changedDiffBlocks,
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

export function analyzeChangedLineBlock(
  block: readonly (ParsedDiffLine | null)[],
  wordEmphasis: DiffWordEmphasis,
): ChangedLineBlockAnalysis {
  const removed: Array<IndexedChangedLine<RemovedDiffLine>> = [];
  const added: Array<IndexedChangedLine<AddedDiffLine>> = [];
  for (const [index, line] of block.entries()) {
    if (line?.kind === "-") removed.push({ index, line });
    else if (line?.kind === "+") added.push({ index, line });
  }
  const removedByIndex = new Map(Arr.map(removed, (line) => [line.index, line]));
  const addedByIndex = new Map(Arr.map(added, (line) => [line.index, line]));
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
