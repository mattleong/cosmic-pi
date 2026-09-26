import type { TextRange } from "./ranges";
import {
  commonPrefixLength,
  commonSuffixLength,
  needsBoundarySafeOffsets,
} from "./text-boundaries";
import {
  isIdentifierToken,
  isMeaningfulOperatorToken,
  isNumberToken,
  type WordEmphasisToken,
} from "./tokens";
import type { WordChangeRanges } from "./types";

export function refinedTokenTextRanges(
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
