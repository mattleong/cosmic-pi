const ALIGNMENT_SCORE_EPSILON = 1e-9;

/** Pair weight, or `-Infinity` for a pair that may not align. DP cells stay finite and >= 0. */
type PairScoreAt = (beforeIndex: number, afterIndex: number) => number;

function sameAlignmentScore(a: number, b: number): boolean {
  return Math.abs(a - b) < ALIGNMENT_SCORE_EPSILON;
}

export function suffixAlignedPairs(
  beforeLength: number,
  afterLength: number,
  scoreAt: PairScoreAt,
): Array<[number, number]> {
  const columns = afterLength + 1;
  const dp = new Float64Array((beforeLength + 1) * columns);

  for (let i = beforeLength - 1; i >= 0; i--) {
    const rowOffset = i * columns;
    const nextRowOffset = rowOffset + columns;
    for (let j = afterLength - 1; j >= 0; j--) {
      const align = dp[nextRowOffset + j + 1]! + scoreAt(i, j);
      dp[rowOffset + j] = Math.max(align, dp[nextRowOffset + j]!, dp[rowOffset + j + 1]!);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < beforeLength && j < afterLength) {
    const rowOffset = i * columns;
    const nextRowOffset = rowOffset + columns;
    if (sameAlignmentScore(dp[rowOffset + j]!, dp[nextRowOffset + j + 1]! + scoreAt(i, j))) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[nextRowOffset + j]! >= dp[rowOffset + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function prefixAlignedPairs(
  beforeLength: number,
  afterLength: number,
  scoreAt: PairScoreAt,
): Array<[number, number]> {
  // Reversing both axes preserves the prefix walk's end-first tie-breaking.
  return suffixAlignedPairs(beforeLength, afterLength, (i, j) =>
    scoreAt(beforeLength - 1 - i, afterLength - 1 - j),
  )
    .map(([i, j]): [number, number] => [beforeLength - 1 - i, afterLength - 1 - j])
    .toReversed();
}

export function suffixAlignmentScore(
  beforeLength: number,
  afterLength: number,
  scoreAt: PairScoreAt,
): number {
  let next = new Float64Array(afterLength + 1);
  let current = new Float64Array(afterLength + 1);

  for (let i = beforeLength - 1; i >= 0; i--) {
    current[afterLength] = 0;
    for (let j = afterLength - 1; j >= 0; j--) {
      current[j] = Math.max(next[j + 1]! + scoreAt(i, j), next[j]!, current[j + 1]!);
    }
    [next, current] = [current, next];
  }

  return next[0]!;
}
