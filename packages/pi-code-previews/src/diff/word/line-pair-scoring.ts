import type { WordChangeConfidence } from "./types";

export type ChangedLineScoreAt = (removedPosition: number, addedPosition: number) => number;

export type TopTwoCandidateValues = { best: number; second: number };

export const MIN_CHANGED_LINE_PAIR_SCORE = 0.45;
export const MIN_POSITIONAL_FALLBACK_PAIR_SCORE = 0.28;
export const MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE = 0.72;
const CHANGED_LINE_PAIR_AMBIGUITY_MARGIN = 0.06;
const CHANGED_LINE_PAIR_AMBIGUITY_RATIO = 0.92;
const HIGH_CONFIDENCE_CROSSING_PAIR_MARGIN = 0.12;
const HIGH_CONFIDENCE_CROSSING_PAIR_RATIO = 0.85;

export function competingChangedLineScoreAt(
  removedLength: number,
  addedLength: number,
  removedPosition: number,
  addedPosition: number,
  scoreAt: ChangedLineScoreAt,
  usedRemoved?: ReadonlySet<number>,
  usedAdded?: ReadonlySet<number>,
): number {
  let competingScore = 0;
  for (
    let candidateAddedPosition = 0;
    candidateAddedPosition < addedLength;
    candidateAddedPosition++
  ) {
    if (candidateAddedPosition === addedPosition || usedAdded?.has(candidateAddedPosition))
      continue;
    competingScore = Math.max(competingScore, scoreAt(removedPosition, candidateAddedPosition));
  }
  for (
    let candidateRemovedPosition = 0;
    candidateRemovedPosition < removedLength;
    candidateRemovedPosition++
  ) {
    if (candidateRemovedPosition === removedPosition || usedRemoved?.has(candidateRemovedPosition))
      continue;
    competingScore = Math.max(competingScore, scoreAt(candidateRemovedPosition, addedPosition));
  }
  return competingScore;
}

export function isAmbiguousChangedLinePairScore(score: number, competingScore: number): boolean {
  return (
    competingScore >= MIN_POSITIONAL_FALLBACK_PAIR_SCORE &&
    (score - competingScore <= CHANGED_LINE_PAIR_AMBIGUITY_MARGIN ||
      competingScore >= score * CHANGED_LINE_PAIR_AMBIGUITY_RATIO)
  );
}

export function isReciprocalBestChangedLinePair(score: number, competingScore: number): boolean {
  return score > competingScore && !isAmbiguousChangedLinePairScore(score, competingScore);
}

export function linePairConfidence(score: number, competingScore: number): WordChangeConfidence {
  if (
    score >= MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE &&
    score - competingScore >= HIGH_CONFIDENCE_CROSSING_PAIR_MARGIN &&
    competingScore <= score * HIGH_CONFIDENCE_CROSSING_PAIR_RATIO
  )
    return "high";
  return "medium";
}

export function topTwoCandidateValues<T>(
  candidates: T[],
  position: (candidate: T) => number,
  value: (candidate: T) => number,
): Map<number, TopTwoCandidateValues> {
  const values = new Map<number, TopTwoCandidateValues>();
  for (const candidate of candidates) {
    const current = values.get(position(candidate)) ?? { best: 0, second: 0 };
    const candidateValue = value(candidate);
    if (candidateValue >= current.best) {
      current.second = current.best;
      current.best = candidateValue;
    } else if (candidateValue > current.second) current.second = candidateValue;
    values.set(position(candidate), current);
  }
  return values;
}

export function competingCandidateValue(
  values: TopTwoCandidateValues | undefined,
  candidateValue: number,
): number {
  if (!values) return 0;
  return candidateValue === values.best ? values.second : values.best;
}
