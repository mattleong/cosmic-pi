import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { changedLineAt, type IndexedChangedLine } from "./changed-line";
import {
  changedLineSimilarityDocuments,
  fallbackLineSimilarity,
  hasUniqueSharedSimilarityFeature,
  similarityTokenListWeight,
  similarityTokenWeight,
} from "./line-similarity";
import {
  competingCandidateValues,
  competingChangedLineScoreAt,
  isAmbiguousChangedLinePairScore,
  isReciprocalBestChangedLinePair,
  linePairConfidence,
  MIN_CHANGED_LINE_PAIR_SCORE,
  MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
  type ChangedLineScoreAt,
  type ChangedLinePositionMatch,
} from "./line-pair-scoring";
import {
  compareSparseCandidates,
  hasStrongSparseEvidence,
  sparseChangedLinePairCandidates,
  type SparseChangedLinePairCandidate,
} from "./sparse-candidates";

type ScoredSparseChangedLinePairCandidate = SparseChangedLinePairCandidate & {
  score: number;
};

const MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS = 10_000;
export function matchChangedLinesSparse(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePositionMatch[] {
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
  const usedRemoved = new Set(pairs.map((pair) => pair.removedPosition));
  const usedAdded = new Set(pairs.map((pair) => pair.addedPosition));

  for (let index = 0; index < Math.min(removed.length, added.length); index++) {
    if (usedRemoved.has(index) || usedAdded.has(index)) continue;
    const score = scoreAt(index, index);
    if (score < MIN_POSITIONAL_FALLBACK_PAIR_SCORE) continue;
    const removedLine = changedLineAt(removed, index);
    const addedLine = changedLineAt(added, index);
    let competingScore = 0;
    if (!hasUniqueSharedSimilarityFeature(removedLine, addedLine, similarityDocuments)) {
      if (!canCheckAmbiguity) continue;
      competingScore = competingChangedLineScoreAt(
        removed.length,
        added.length,
        index,
        index,
        scoreAt,
      );
      if (isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    }
    pairs.push({
      removedPosition: index,
      addedPosition: index,
      confidence: linePairConfidence(score, competingScore),
    });
  }
  return pairs;
}

function sparseChangedLineAnchors(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  sparseCandidates: SparseChangedLinePairCandidate[],
  scoreAt: ChangedLineScoreAt,
): ChangedLinePositionMatch[] {
  const scoredCandidates: ScoredSparseChangedLinePairCandidate[] = sparseCandidates
    .map((candidate) => ({
      ...candidate,
      score: scoreAt(candidate.removedPosition, candidate.addedPosition),
    }))
    .toSorted((a, b) => b.score - a.score || compareSparseCandidates(a, b));
  const candidateCompetingScore = competingCandidateValues(
    scoredCandidates,
    (candidate) => candidate.score,
  );
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  const pairs: ChangedLinePositionMatch[] = [];

  for (const candidate of scoredCandidates) {
    if (candidate.score < MIN_CHANGED_LINE_PAIR_SCORE) continue;
    if (usedRemoved.has(candidate.removedPosition) || usedAdded.has(candidate.addedPosition))
      continue;
    if (!hasStrongSparseEvidence(candidate)) continue;
    const competingScore = Math.max(
      candidateCompetingScore(candidate),
      sparsePositionalCompetingScore(candidate, removed.length, added.length, scoreAt),
    );
    if (!isReciprocalBestChangedLinePair(candidate.score, competingScore)) continue;
    usedRemoved.add(candidate.removedPosition);
    usedAdded.add(candidate.addedPosition);
    pairs.push({
      removedPosition: candidate.removedPosition,
      addedPosition: candidate.addedPosition,
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
