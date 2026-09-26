import type { DiffWordEmphasis } from "../../config/schema";
import { refinedRangesForChangedTokens } from "./range-refinement";
import { filterLowSignalWordEmphasis } from "./smart-filter";
import { changedTokenGaps } from "./token-alignment";
import {
  hasWordChangeRanges,
  type ConfidentWordChangeRanges,
  type WordChangeConfidence,
  type WordChangeRanges,
} from "./types";
import { wordEmphasisTokens, type WordEmphasisToken } from "./tokens";

export function shouldEmphasizeChangedPair(
  ranges: ConfidentWordChangeRanges,
  lineConfidence: WordChangeConfidence,
): boolean {
  if (ranges.removed.length === 0 && ranges.added.length === 0) return false;
  if (lineConfidence === "low") return false;
  if (ranges.confidence === "low" && lineConfidence !== "high") return false;
  return true;
}

export function changedRanges(
  before: string,
  after: string,
  wordEmphasis: DiffWordEmphasis,
): WordChangeRanges {
  return stripWordChangeConfidence(changedRangesWithConfidence(before, after, wordEmphasis));
}

export function changedRangesWithConfidence(
  before: string,
  after: string,
  wordEmphasis: DiffWordEmphasis,
  beforeTokens: WordEmphasisToken[] = wordEmphasisTokens(before),
  afterTokens: WordEmphasisToken[] = wordEmphasisTokens(after),
): ConfidentWordChangeRanges {
  if (wordEmphasis === "off") return { removed: [], added: [], confidence: "low" };

  const { gaps, confidence: alignmentConfidence } = changedTokenGaps(beforeTokens, afterTokens);
  const ranges = refinedRangesForChangedTokens(before, beforeTokens, after, afterTokens, gaps);
  const confidence: WordChangeConfidence = hasWordChangeRanges(ranges)
    ? alignmentConfidence
    : "low";
  if (wordEmphasis !== "smart") return { ...ranges, confidence };

  const filtered = filterLowSignalWordEmphasis(before, after, ranges);
  return { ...filtered, confidence: hasWordChangeRanges(filtered) ? confidence : "low" };
}

function stripWordChangeConfidence(ranges: ConfidentWordChangeRanges): WordChangeRanges {
  return { removed: ranges.removed, added: ranges.added };
}
