import type { DiffWordEmphasis } from "../../config/schema";
import { refinedRangesForChangedTokens } from "./range-refinement";
import { filterLowSignalWordEmphasis } from "./smart-filter";
import { changedTokenGaps } from "./token-alignment";
import {
  hasWordChangeRanges,
  type ConfidentWordChangeRanges,
  type WordChangeConfidence,
} from "./types";
import { wordEmphasisTokens, type WordEmphasisToken } from "./tokens";

export function shouldEmphasizeChangedPair(
  ranges: ConfidentWordChangeRanges,
  lineConfidence: WordChangeConfidence,
): boolean {
  return (
    hasWordChangeRanges(ranges) &&
    lineConfidence !== "low" &&
    (ranges.confidence !== "low" || lineConfidence === "high")
  );
}

export function changedRangesWithConfidence(
  before: string,
  after: string,
  wordEmphasis: DiffWordEmphasis,
  beforeTokens: WordEmphasisToken[] = wordEmphasisTokens(before),
  afterTokens: WordEmphasisToken[] = wordEmphasisTokens(after),
): ConfidentWordChangeRanges {
  if (wordEmphasis === "off") return { removed: [], added: [], confidence: "low" };

  const { gaps, confidence } = changedTokenGaps(beforeTokens, afterTokens);
  const ranges = refinedRangesForChangedTokens(before, beforeTokens, after, afterTokens, gaps);
  // The smart filter only removes ranges, so it never turns an empty result non-empty.
  const shown =
    wordEmphasis === "smart" ? filterLowSignalWordEmphasis(before, after, ranges) : ranges;
  return { ...shown, confidence: hasWordChangeRanges(shown) ? confidence : "low" };
}
