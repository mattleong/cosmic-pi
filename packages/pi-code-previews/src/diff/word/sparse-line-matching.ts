import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { changedLineAt, changedLinePositions, type IndexedChangedLine } from "./changed-line";
import {
  changedLineSimilarityDocuments,
  fallbackLineSimilarity,
  hasUniqueSharedSimilarityFeature,
  similarityTokenListWeight,
  similarityTokenWeight,
} from "./line-similarity";
import type { WordChangeConfidence } from "./types";
import {
  competingCandidateValue,
  competingChangedLineScoreAt,
  isAmbiguousChangedLinePairScore,
  isReciprocalBestChangedLinePair,
  linePairConfidence,
  MIN_CHANGED_LINE_PAIR_SCORE,
  MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
  topTwoCandidateValues,
  type ChangedLineScoreAt,
} from "./line-pair-scoring";
import {
  compareSparseCandidates,
  hasStrongSparseEvidence,
  sparseChangedLinePairCandidates,
  type SparseChangedLinePairCandidate,
} from "./sparse-candidates";

export type SparseChangedLinePair = {
  removedIndex: number;
  addedIndex: number;
  confidence: WordChangeConfidence;
};

type ScoredSparseChangedLinePairCandidate = SparseChangedLinePairCandidate & {
  score: number;
};

const MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS = 10_000;
export function matchChangedLinesSparse(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): SparseChangedLinePair[] {
  const similarityDocuments = changedLineSimilarityDocuments(removed, added);
  const tokenWeight = similarityTokenWeight(similarityDocuments);
  const removedWeights: Array<number | undefined> = [];
  const addedWeights: Array<number | undefined> = [];
  const canCheckAmbiguity =
    removed.length * added.length <= MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS;
  const scoreCache = canCheckAmbiguity ? new Map<number, number>() : undefined;
  const scoreAt = (removedPosition: number, addedPosition: number): number => {
    const key = removedPosition * added.length + addedPosition;
    const cached = scoreCache?.get(key);
    if (cached !== undefined) return cached;
    const removedFeatures = similarityDocuments.removedFeatures[removedPosition];
    const addedFeatures = similarityDocuments.addedFeatures[addedPosition];
    if (removedFeatures === undefined || addedFeatures === undefined)
      throw new RangeError(`Missing similarity features ${removedPosition}:${addedPosition}`);
    const removedWeight = (removedWeights[removedPosition] ??= similarityTokenListWeight(
      removedFeatures,
      tokenWeight,
    ));
    const addedWeight = (addedWeights[addedPosition] ??= similarityTokenListWeight(
      addedFeatures,
      tokenWeight,
    ));
    const score = fallbackLineSimilarity(
      changedLineAt(removed, removedPosition),
      changedLineAt(added, addedPosition),
      tokenWeight,
      removedWeight,
      addedWeight,
    );
    scoreCache?.set(key, score);
    return score;
  };

  const sparseCandidates = sparseChangedLinePairCandidates(similarityDocuments, tokenWeight);
  const pairs = sparseChangedLineAnchors(removed, added, sparseCandidates, scoreAt);
  const positions = changedLinePositions(removed, added);
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  for (const pair of pairs) {
    const removedPosition = positions.removed.get(pair.removedIndex);
    const addedPosition = positions.added.get(pair.addedIndex);
    if (removedPosition !== undefined) usedRemoved.add(removedPosition);
    if (addedPosition !== undefined) usedAdded.add(addedPosition);
  }

  for (let index = 0; index < Math.min(removed.length, added.length); index++) {
    if (usedRemoved.has(index) || usedAdded.has(index)) continue;
    const score = scoreAt(index, index);
    if (score < MIN_POSITIONAL_FALLBACK_PAIR_SCORE) continue;
    const removedLine = changedLineAt(removed, index);
    const addedLine = changedLineAt(added, index);
    if (hasUniqueSharedSimilarityFeature(removedLine, addedLine, similarityDocuments)) {
      pairs.push({
        removedIndex: removedLine.index,
        addedIndex: addedLine.index,
        confidence: linePairConfidence(score, 0),
      });
      usedRemoved.add(index);
      usedAdded.add(index);
      continue;
    }
    if (!canCheckAmbiguity) continue;

    const competingScore = competingChangedLineScoreAt(
      removed.length,
      added.length,
      index,
      index,
      scoreAt,
    );
    if (isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    pairs.push({
      removedIndex: removedLine.index,
      addedIndex: addedLine.index,
      confidence: linePairConfidence(score, competingScore),
    });
    usedRemoved.add(index);
    usedAdded.add(index);
  }
  return pairs.toSorted(
    (a, b) =>
      (positions.removed.get(a.removedIndex) ?? 0) - (positions.removed.get(b.removedIndex) ?? 0),
  );
}

function sparseChangedLineAnchors(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  sparseCandidates: SparseChangedLinePairCandidate[],
  scoreAt: ChangedLineScoreAt,
): SparseChangedLinePair[] {
  const scoredCandidates: ScoredSparseChangedLinePairCandidate[] = sparseCandidates
    .map((candidate) => ({
      ...candidate,
      score: scoreAt(candidate.removedPosition, candidate.addedPosition),
    }))
    .toSorted((a, b) => b.score - a.score || compareSparseCandidates(a, b));
  const removedScores = topTwoCandidateValues(
    scoredCandidates,
    (candidate) => candidate.removedPosition,
    (candidate) => candidate.score,
  );
  const addedScores = topTwoCandidateValues(
    scoredCandidates,
    (candidate) => candidate.addedPosition,
    (candidate) => candidate.score,
  );
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const pairs: SparseChangedLinePair[] = [];

  for (const candidate of scoredCandidates) {
    if (candidate.score < MIN_CHANGED_LINE_PAIR_SCORE) continue;
    if (usedRemoved.has(candidate.removedPosition) || usedAdded.has(candidate.addedPosition))
      continue;
    if (!hasStrongSparseEvidence(candidate)) continue;
    const competingScore = Math.max(
      competingCandidateValue(removedScores.get(candidate.removedPosition), candidate.score),
      competingCandidateValue(addedScores.get(candidate.addedPosition), candidate.score),
      sparsePositionalCompetingScore(candidate, removed.length, added.length, scoreAt),
    );
    if (!isReciprocalBestChangedLinePair(candidate.score, competingScore)) continue;
    usedRemoved.add(candidate.removedPosition);
    usedAdded.add(candidate.addedPosition);
    pairs.push({
      removedIndex: changedLineAt(removed, candidate.removedPosition).index,
      addedIndex: changedLineAt(added, candidate.addedPosition).index,
      confidence: linePairConfidence(candidate.score, competingScore),
    });
  }
  return pairs;
}

function sparsePositionalCompetingScore(
  candidate: SparseChangedLinePairCandidate,
  removedLength: number,
  addedLength: number,
  scoreAt: ChangedLineScoreAt,
): number {
  let competingScore = 0;
  if (
    candidate.removedPosition < addedLength &&
    candidate.addedPosition !== candidate.removedPosition
  )
    competingScore = scoreAt(candidate.removedPosition, candidate.removedPosition);
  if (
    candidate.addedPosition < removedLength &&
    candidate.removedPosition !== candidate.addedPosition
  )
    competingScore = Math.max(
      competingScore,
      scoreAt(candidate.addedPosition, candidate.addedPosition),
    );
  return competingScore;
}
