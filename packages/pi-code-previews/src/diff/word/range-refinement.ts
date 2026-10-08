import {
  commonPrefixLength,
  commonSuffixLength,
  needsBoundarySafeOffsets,
  rangesAtGraphemeBoundaries,
} from "./text-boundaries";
import { changedTokenGaps, type ChangedTokenGap, type TokenGroup } from "./token-alignment";
import { unorderedTokenSimilarity } from "./line-similarity";
import {
  identifierSimilarityParts,
  isIdentifierToken,
  isMeaningfulOperatorToken,
  isNumberToken,
  splitIdentifierToken,
  tokenAt,
  wordEmphasisTokenWeight,
  type WordEmphasisToken,
} from "./tokens";
import { hasWordChangeRanges, type TextRange, type WordChangeRanges } from "./types";
import { suffixAlignedPairs } from "./alignment";

const MAX_SOFT_TOKEN_ALIGNMENT_CELLS = 4096;
const MIN_SOFT_TOKEN_SUBSTITUTION_SIMILARITY = 0.45;

export function refinedRangesForChangedTokens(
  beforeText: string,
  beforeTokens: WordEmphasisToken[],
  afterText: string,
  afterTokens: WordEmphasisToken[],
  gaps: ChangedTokenGap[],
): WordChangeRanges {
  const ranges = refinedRangesForTokenGaps(beforeTokens, afterTokens, gaps);
  return {
    removed: mergeRanges(rangesAtGraphemeBoundaries(beforeText, ranges.removed)),
    added: mergeRanges(rangesAtGraphemeBoundaries(afterText, ranges.added)),
  };
}

function refinedRangesForTokenGaps(
  beforeTokens: WordEmphasisToken[],
  afterTokens: WordEmphasisToken[],
  gaps: ChangedTokenGap[],
): WordChangeRanges {
  const removed: TextRange[] = [];
  const added: TextRange[] = [];

  for (const gap of gaps) {
    const removedGroup = nonEmptyTokenGroup(gap.removed);
    const addedGroup = nonEmptyTokenGroup(gap.added);
    const refined =
      removedGroup && addedGroup
        ? (refinedSingleTokenRanges(beforeTokens, removedGroup, afterTokens, addedGroup) ??
          refinedSoftTokenGroupRanges(beforeTokens, removedGroup, afterTokens, addedGroup))
        : undefined;
    if (refined) {
      removed.push(...refined.removed);
      added.push(...refined.added);
      continue;
    }
    if (removedGroup) removed.push(...rangesForTokenGroup(beforeTokens, removedGroup));
    if (addedGroup) added.push(...rangesForTokenGroup(afterTokens, addedGroup));
  }

  return { removed: mergeRanges(removed), added: mergeRanges(added) };
}

function nonEmptyTokenGroup(group: TokenGroup): TokenGroup | undefined {
  return group.start < group.end ? group : undefined;
}

function rangesForTokenGroup(tokens: WordEmphasisToken[], group: TokenGroup): TextRange[] {
  return mergeRanges(
    tokens.slice(group.start, group.end).map((token): TextRange => [token.start, token.end]),
  );
}

/** Joins start-sorted ranges separated by at most one character. */
function mergeRanges(ranges: TextRange[]): TextRange[] {
  const merged: TextRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] - previous[1] <= 1) previous[1] = range[1];
    else merged.push([...range]);
  }
  return merged;
}

function refinedSingleTokenRanges(
  beforeTokens: WordEmphasisToken[],
  beforeGroup: TokenGroup,
  afterTokens: WordEmphasisToken[],
  afterGroup: TokenGroup,
): WordChangeRanges | undefined {
  if (beforeGroup.end - beforeGroup.start !== 1 || afterGroup.end - afterGroup.start !== 1)
    return undefined;
  return refinedTokenPairRanges(
    tokenAt(beforeTokens, beforeGroup.start),
    tokenAt(afterTokens, afterGroup.start),
  );
}

function refinedTokenPairRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): WordChangeRanges | undefined {
  const identifierRanges = refinedIdentifierTokenRanges(beforeToken, afterToken);
  const textRanges = refinedTokenTextRanges(beforeToken, afterToken);
  if (identifierRanges && isNarrowerThanWholeTokens(identifierRanges, beforeToken, afterToken)) {
    if (shouldSuppressUnbalancedIdentifierPartRefinement(beforeToken, afterToken, textRanges))
      return textRanges;
    if (
      textRanges &&
      (textRanges.removed.length === 0 || textRanges.added.length === 0) &&
      highlightedRangeWidth(textRanges) < highlightedRangeWidth(identifierRanges)
    )
      return textRanges;
    return identifierRanges;
  }
  return textRanges ?? identifierRanges;
}

function highlightedRangeWidth({ removed, added }: WordChangeRanges): number {
  return [...removed, ...added].reduce((width, [start, end]) => width + end - start, 0);
}

function shouldSuppressUnbalancedIdentifierPartRefinement(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
  textRanges: WordChangeRanges | undefined,
): boolean {
  if (textRanges) return false;
  if (!isIdentifierToken(beforeToken.value) || !isIdentifierToken(afterToken.value)) return false;
  const beforePartCount = identifierSimilarityParts(beforeToken.value).length;
  const afterPartCount = identifierSimilarityParts(afterToken.value).length;
  return Math.min(beforePartCount, afterPartCount) === 1 && beforePartCount !== afterPartCount;
}

/** Narrows a token pair to the text between their shared prefix and suffix. */
function refinedTokenTextRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): WordChangeRanges | undefined {
  if (beforeToken.value === afterToken.value) return undefined;
  const prefix = commonPrefixLength(beforeToken.value, afterToken.value);
  const suffix = commonSuffixLength(beforeToken.value, afterToken.value, prefix);
  if (!shouldRefineTokenText(beforeToken.value, afterToken.value, prefix, suffix)) return undefined;
  // Distinct values leave a non-empty middle on at least one side.
  return {
    removed: tokenMiddleRange(beforeToken, prefix, suffix),
    added: tokenMiddleRange(afterToken, prefix, suffix),
  };
}

function tokenMiddleRange(token: WordEmphasisToken, prefix: number, suffix: number): TextRange[] {
  const end = token.value.length - suffix;
  return prefix < end ? [[token.start + prefix, token.start + end]] : [];
}

function shouldRefineTokenText(
  before: string,
  after: string,
  prefix: number,
  suffix: number,
): boolean {
  const sharedEdgeLength = prefix + suffix;
  if (sharedEdgeLength === 0) return false;
  if (isIdentifierToken(before) && isIdentifierToken(after)) {
    if (
      sharedEdgeLength < 2 &&
      !needsBoundarySafeOffsets(before) &&
      !needsBoundarySafeOffsets(after)
    )
      return false;
    if (prefix === 0 && suffix > 0) {
      const beforeChangedLength = before.length - suffix;
      const afterChangedLength = after.length - suffix;
      if (
        beforeChangedLength !== afterChangedLength &&
        Math.min(beforeChangedLength, afterChangedLength) < 2
      )
        return false;
    }
    return true;
  }
  if (isNumberToken(before) && isNumberToken(after)) return true;
  if (isMeaningfulOperatorToken(before) && isMeaningfulOperatorToken(after)) return true;
  return false;
}

function refinedSoftTokenGroupRanges(
  beforeTokens: WordEmphasisToken[],
  beforeGroup: TokenGroup,
  afterTokens: WordEmphasisToken[],
  afterGroup: TokenGroup,
): WordChangeRanges | undefined {
  const before = beforeTokens.slice(beforeGroup.start, beforeGroup.end);
  const after = afterTokens.slice(afterGroup.start, afterGroup.end);
  if (before.length * after.length > MAX_SOFT_TOKEN_ALIGNMENT_CELLS) return undefined;
  const pairs = softAlignedTokenPairs(before, after);
  if (pairs.length === 0) return undefined;

  const pairedBefore = new Set<number>();
  const pairedAfter = new Set<number>();
  const removed: TextRange[] = [];
  const added: TextRange[] = [];

  for (const [beforeIndex, afterIndex] of pairs) {
    pairedBefore.add(beforeIndex);
    pairedAfter.add(afterIndex);
    const beforeToken = tokenAt(before, beforeIndex);
    const afterToken = tokenAt(after, afterIndex);
    if (beforeToken.value === afterToken.value) continue;
    const refined = refinedTokenPairRanges(beforeToken, afterToken);
    if (refined) {
      removed.push(...refined.removed);
      added.push(...refined.added);
    } else {
      removed.push([beforeToken.start, beforeToken.end]);
      added.push([afterToken.start, afterToken.end]);
    }
  }

  for (const [index, token] of before.entries())
    if (!pairedBefore.has(index)) removed.push([token.start, token.end]);
  for (const [index, token] of after.entries())
    if (!pairedAfter.has(index)) added.push([token.start, token.end]);

  const result = {
    removed: mergeRanges(removed.toSorted((a, b) => a[0] - b[0])),
    added: mergeRanges(added.toSorted((a, b) => a[0] - b[0])),
  };
  return hasWordChangeRanges(result) ? result : undefined;
}

function softAlignedTokenPairs(
  before: WordEmphasisToken[],
  after: WordEmphasisToken[],
): Array<[number, number]> {
  return suffixAlignedPairs(before.length, after.length, (beforeIndex, afterIndex) => {
    const substitution = softTokenSubstitutionWeight(
      tokenAt(before, beforeIndex),
      tokenAt(after, afterIndex),
    );
    return substitution > 0 ? substitution : Number.NEGATIVE_INFINITY;
  });
}

function softTokenSubstitutionWeight(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): number {
  if (beforeToken.value === afterToken.value) return wordEmphasisTokenWeight(beforeToken.value);
  const similarity = softTokenSimilarity(beforeToken.value, afterToken.value);
  return similarity >= MIN_SOFT_TOKEN_SUBSTITUTION_SIMILARITY
    ? Math.min(
        wordEmphasisTokenWeight(beforeToken.value),
        wordEmphasisTokenWeight(afterToken.value),
      ) * similarity
    : 0;
}

function softTokenSimilarity(before: string, after: string): number {
  if (isIdentifierToken(before) && isIdentifierToken(after))
    return identifierTokenSimilarity(before, after);
  if (isNumberToken(before) && isNumberToken(after)) return edgeTextSimilarity(before, after);
  if (isMeaningfulOperatorToken(before) && isMeaningfulOperatorToken(after))
    return edgeTextSimilarity(before, after);
  return 0;
}

function identifierTokenSimilarity(before: string, after: string): number {
  const beforeParts = identifierSimilarityParts(before);
  const afterParts = identifierSimilarityParts(after);
  const partSimilarity =
    beforeParts.length > 0 && afterParts.length > 0
      ? unorderedTokenSimilarity(beforeParts, afterParts, () => 1)
      : 0;
  return Math.max(partSimilarity, edgeTextSimilarity(before, after));
}

function edgeTextSimilarity(before: string, after: string): number {
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  return (2 * (prefix + suffix)) / (before.length + after.length);
}

function refinedIdentifierTokenRanges(
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): WordChangeRanges | undefined {
  if (!isIdentifierToken(beforeToken.value) || !isIdentifierToken(afterToken.value))
    return undefined;
  const beforeParts = splitIdentifierToken(beforeToken.value, beforeToken.start);
  const afterParts = splitIdentifierToken(afterToken.value, afterToken.start);
  if (beforeParts.length <= 1 && afterParts.length <= 1) return undefined;

  const { gaps } = changedTokenGaps(beforeParts, afterParts);
  const ranges = refinedRangesForTokenGaps(beforeParts, afterParts, gaps);
  return hasWordChangeRanges(ranges) ? ranges : undefined;
}

function isNarrowerThanWholeTokens(
  ranges: WordChangeRanges,
  beforeToken: WordEmphasisToken,
  afterToken: WordEmphasisToken,
): boolean {
  return (
    ranges.removed.some((range) => range[0] > beforeToken.start || range[1] < beforeToken.end) ||
    ranges.added.some((range) => range[0] > afterToken.start || range[1] < afterToken.end) ||
    ranges.removed.length === 0 ||
    ranges.added.length === 0
  );
}
