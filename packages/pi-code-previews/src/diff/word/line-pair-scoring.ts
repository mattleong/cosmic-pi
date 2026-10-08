import type { WordChangeConfidence } from "./types";

export type ChangedLineScoreAt = (removedPosition: number, addedPosition: number) => number;

type ChangedLinePositions = { removedPosition: number; addedPosition: number };

export type ChangedLinePositionMatch = ChangedLinePositions & { confidence: WordChangeConfidence };

type TopTwoCandidateValues = { best: number; second: number };

export const MIN_CHANGED_LINE_PAIR_SCORE = 0.45;
export const MIN_POSITIONAL_FALLBACK_PAIR_SCORE = 0.28;
export const MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE = 0.72;
const CHANGED_LINE_PAIR_AMBIGUITY_MARGIN = 0.06;
const CHANGED_LINE_PAIR_AMBIGUITY_RATIO = 0.92;
const HIGH_CONFIDENCE_CROSSING_PAIR_MARGIN = 0.12;
const HIGH_CONFIDENCE_CROSSING_PAIR_RATIO = 0.85;

/** The best score either line of a pair reaches with another partner not yet used. */
export type CompetingChangedLineScoreAt = (
  removedPosition: number,
  addedPosition: number,
  usedRemoved?: ReadonlySet<number>,
  usedAdded?: ReadonlySet<number>,
) => number;

export const competingChangedLineScores =
  (
    removedLength: number,
    addedLength: number,
    scoreAt: ChangedLineScoreAt,
  ): CompetingChangedLineScoreAt =>
  (removedPosition, addedPosition, usedRemoved, usedAdded) => {
    let competingScore = 0;
    for (let candidate = 0; candidate < addedLength; candidate++) {
      if (candidate === addedPosition || usedAdded?.has(candidate)) continue;
      competingScore = Math.max(competingScore, scoreAt(removedPosition, candidate));
    }
    for (let candidate = 0; candidate < removedLength; candidate++) {
      if (candidate === removedPosition || usedRemoved?.has(candidate)) continue;
      competingScore = Math.max(competingScore, scoreAt(candidate, addedPosition));
    }
    return competingScore;
  };

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

export function competingCandidateValues<T extends ChangedLinePositions>(
  candidates: T[],
  value: (candidate: T) => number,
): (candidate: T) => number {
  const removed = topTwoCandidateValues(
    candidates,
    (candidate) => candidate.removedPosition,
    value,
  );
  const added = topTwoCandidateValues(candidates, (candidate) => candidate.addedPosition, value);
  return (candidate) =>
    Math.max(
      competingCandidateValue(removed.get(candidate.removedPosition), value(candidate)),
      competingCandidateValue(added.get(candidate.addedPosition), value(candidate)),
    );
}

function topTwoCandidateValues<T>(
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

function competingCandidateValue(
  values: TopTwoCandidateValues | undefined,
  candidateValue: number,
): number {
  if (!values) return 0;
  return candidateValue === values.best ? values.second : values.best;
}
