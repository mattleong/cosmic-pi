import { requiredAt, type WordChangeConfidence } from "./types";
import { tokenAt, wordEmphasisTokenWeight, type WordEmphasisToken } from "./tokens";
import { suffixAlignedPairs } from "./alignment";
import type { TokenGroup } from "./ranges";

const WORD_EMPHASIS_EXACT_LCS_MAX_CELLS = 262_144;

export type ChangedTokenGap = { removed: TokenGroup; added: TokenGroup };

export function changedTokenGaps(before: WordEmphasisToken[], after: WordEmphasisToken[]) {
  const gaps: ChangedTokenGap[] = [];

  function appendGap(
    beforeStart: number,
    beforeEnd: number,
    afterStart: number,
    afterEnd: number,
  ): void {
    if (beforeStart === beforeEnd && afterStart === afterEnd) return;
    gaps.push({
      removed: { start: beforeStart, end: beforeEnd },
      added: { start: afterStart, end: afterEnd },
    });
  }

  function collect(
    beforeStart: number,
    beforeEnd: number,
    afterStart: number,
    afterEnd: number,
  ): WordChangeConfidence {
    while (
      beforeStart < beforeEnd &&
      afterStart < afterEnd &&
      tokenAt(before, beforeStart).value === tokenAt(after, afterStart).value
    ) {
      beforeStart++;
      afterStart++;
    }

    while (
      beforeStart < beforeEnd &&
      afterStart < afterEnd &&
      tokenAt(before, beforeEnd - 1).value === tokenAt(after, afterEnd - 1).value
    ) {
      beforeEnd--;
      afterEnd--;
    }

    if (beforeStart === beforeEnd || afterStart === afterEnd) {
      appendGap(beforeStart, beforeEnd, afterStart, afterEnd);
      return "high";
    }

    if ((beforeEnd - beforeStart) * (afterEnd - afterStart) <= WORD_EMPHASIS_EXACT_LCS_MAX_CELLS) {
      collectByLcs(beforeStart, beforeEnd, afterStart, afterEnd);
      return "high";
    }

    const anchors = uniqueOrderedAnchors(beforeStart, beforeEnd, afterStart, afterEnd);
    if (anchors.length === 0) {
      appendGap(beforeStart, beforeEnd, afterStart, afterEnd);
      return "low";
    }

    let confidence: WordChangeConfidence = "high";
    let previousBefore = beforeStart;
    let previousAfter = afterStart;
    for (const anchor of anchors) {
      confidence = lowerWordChangeConfidence(
        confidence,
        collect(previousBefore, anchor.beforeIndex, previousAfter, anchor.afterIndex),
      );
      previousBefore = anchor.beforeIndex + 1;
      previousAfter = anchor.afterIndex + 1;
    }
    confidence = lowerWordChangeConfidence(
      confidence,
      collect(previousBefore, beforeEnd, previousAfter, afterEnd),
    );
    return lowerWordChangeConfidence(confidence, "medium");
  }

  function collectByLcs(
    beforeStart: number,
    beforeEnd: number,
    afterStart: number,
    afterEnd: number,
  ): void {
    const pairs = suffixAlignedPairs(
      beforeEnd - beforeStart,
      afterEnd - afterStart,
      (beforeIndex, afterIndex) => {
        const beforeToken = tokenAt(before, beforeStart + beforeIndex);
        const afterToken = tokenAt(after, afterStart + afterIndex);
        return beforeToken.value === afterToken.value
          ? wordEmphasisTokenWeight(beforeToken.value)
          : Number.NEGATIVE_INFINITY;
      },
    );

    let beforeIndex = 0;
    let afterIndex = 0;
    for (const [nextBeforeIndex, nextAfterIndex] of pairs) {
      appendGap(
        beforeStart + beforeIndex,
        beforeStart + nextBeforeIndex,
        afterStart + afterIndex,
        afterStart + nextAfterIndex,
      );
      beforeIndex = nextBeforeIndex + 1;
      afterIndex = nextAfterIndex + 1;
    }
    appendGap(beforeStart + beforeIndex, beforeEnd, afterStart + afterIndex, afterEnd);
  }

  function uniqueOrderedAnchors(
    beforeStart: number,
    beforeEnd: number,
    afterStart: number,
    afterEnd: number,
  ): Array<{ beforeIndex: number; afterIndex: number }> {
    const beforeCounts = tokenCounts(before, beforeStart, beforeEnd);
    const afterCounts = tokenCounts(after, afterStart, afterEnd);
    const afterUniqueIndexes = new Map<string, number>();
    for (let index = afterStart; index < afterEnd; index++) {
      const value = tokenAt(after, index).value;
      if (beforeCounts.get(value) === 1 && afterCounts.get(value) === 1)
        afterUniqueIndexes.set(value, index);
    }
    const candidates: Array<{ beforeIndex: number; afterIndex: number }> = [];
    for (let index = beforeStart; index < beforeEnd; index++) {
      const value = tokenAt(before, index).value;
      if (beforeCounts.get(value) !== 1 || afterCounts.get(value) !== 1) continue;
      const afterIndex = afterUniqueIndexes.get(value);
      if (afterIndex !== undefined) candidates.push({ beforeIndex: index, afterIndex });
    }
    return longestIncreasingAfterIndexes(candidates);
  }

  const confidence = collect(0, before.length, 0, after.length);
  return { gaps, confidence };
}

function lowerWordChangeConfidence(
  a: WordChangeConfidence,
  b: WordChangeConfidence,
): WordChangeConfidence {
  return WORD_CHANGE_CONFIDENCE_RANK[a] <= WORD_CHANGE_CONFIDENCE_RANK[b] ? a : b;
}

const WORD_CHANGE_CONFIDENCE_RANK = {
  low: 0,
  medium: 1,
  high: 2,
} satisfies Record<WordChangeConfidence, number>;

function longestIncreasingAfterIndexes(
  candidates: Array<{ beforeIndex: number; afterIndex: number }>,
): Array<{ beforeIndex: number; afterIndex: number }> {
  if (candidates.length <= 1) return candidates;
  const tails: number[] = [];
  const previous = Array.from({ length: candidates.length }, () => -1);
  const tailCandidateIndexes: number[] = [];

  for (let index = 0; index < candidates.length; index++) {
    const afterIndex = requiredAt(candidates, index, "anchor candidate").afterIndex;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (requiredAt(tails, middle, "numeric value") < afterIndex) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[index] = requiredAt(tailCandidateIndexes, low - 1, "numeric value");
    tails[low] = afterIndex;
    tailCandidateIndexes[low] = index;
  }

  const ordered: Array<{ beforeIndex: number; afterIndex: number }> = [];
  let index = tailCandidateIndexes[tails.length - 1] ?? -1;
  while (index >= 0) {
    ordered.push(requiredAt(candidates, index, "anchor candidate"));
    index = previous[index] ?? -1;
  }
  return ordered.toReversed();
}

function tokenCounts(tokens: WordEmphasisToken[], start: number, end: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = start; index < end; index++) {
    const value = tokenAt(tokens, index).value;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
