import type { WordChangeConfidence } from "./types";
import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { prefixAlignedPairs } from "./alignment";
import {
  changedLineSimilarityDocuments,
  similarityTokenListWeight,
  similarityTokenWeight,
  tokenSimilarity,
} from "./line-similarity";
import {
  changedLineAt,
  changedLinePositions,
  type ChangedLinePositions,
  type IndexedChangedLine,
} from "./changed-line";
import {
  competingCandidateValue,
  competingChangedLineScoreAt,
  isAmbiguousChangedLinePairScore,
  isReciprocalBestChangedLinePair,
  linePairConfidence,
  MIN_CHANGED_LINE_PAIR_SCORE,
  MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE,
  MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
  type TopTwoCandidateValues,
} from "./line-pair-scoring";
import { matchChangedLinesSparse } from "./sparse-line-matching";

export type ChangedLinePair = {
  removedIndex: number;
  addedIndex: number;
  confidence: WordChangeConfidence;
};

type ChangedLinePairCandidate = {
  removedPosition: number;
  addedPosition: number;
  score: number;
};

type ChangedLinePositionPair = [removedPosition: number, addedPosition: number];
type ChangedLineIndexPair = [removedIndex: number, addedIndex: number];

export function matchChangedLines(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePair[] {
  if (removed.length === 0 || added.length === 0) return [];
  if (removed.length * added.length > MAX_CHANGED_LINE_PAIR_CELLS)
    return matchChangedLinesSparse(removed, added);
  const similarityDocuments = changedLineSimilarityDocuments(removed, added);
  const tokenWeight = similarityTokenWeight(similarityDocuments);
  const { removedFeatures, addedFeatures } = similarityDocuments;
  const removedWeights = removedFeatures.map((tokens) =>
    similarityTokenListWeight(tokens, tokenWeight),
  );
  const addedWeights = addedFeatures.map((tokens) =>
    similarityTokenListWeight(tokens, tokenWeight),
  );
  const scores = removedFeatures.map((beforeTokens, removedPosition) =>
    addedFeatures.map((afterTokens, addedPosition) =>
      tokenSimilarity(
        beforeTokens,
        afterTokens,
        tokenWeight,
        MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
        removedWeights[removedPosition],
        addedWeights[addedPosition],
      ),
    ),
  );
  const similarPairs = prefixAlignedPairs(
    removed.length,
    added.length,
    (removedPosition, addedPosition) => {
      const score = scores[removedPosition]?.[addedPosition] ?? 0;
      return score >= MIN_CHANGED_LINE_PAIR_SCORE ? score + 0.01 : Number.NEGATIVE_INFINITY;
    },
  );
  if (similarPairs.length === 0 && removed.length === 1 && added.length === 1)
    return [
      {
        removedIndex: changedLineAt(removed, 0).index,
        addedIndex: changedLineAt(added, 0).index,
        confidence: "medium",
      },
    ];
  const positions = changedLinePositions(removed, added);
  const confidentPairs = confidentChangedLinePairs(
    positions,
    scores,
    addPositionalFallbackPairs(removed, added, scores, similarPairs),
  );
  return addCrossingPairs(removed, added, scores, positions, confidentPairs);
}

const MAX_CHANGED_LINE_PAIR_CELLS = 1024;

function confidentChangedLinePairs(
  positions: ChangedLinePositions,
  scores: number[][],
  pairs: ChangedLineIndexPair[],
): ChangedLinePair[] {
  const confidentPairs: ChangedLinePair[] = [];
  for (const [removedIndex, addedIndex] of pairs) {
    const removedPosition = positions.removed.get(removedIndex);
    const addedPosition = positions.added.get(addedIndex);
    if (removedPosition === undefined || addedPosition === undefined) continue;
    const score = scores[removedPosition]?.[addedPosition] ?? 0;
    const competingScore = competingChangedLineScore(scores, removedPosition, addedPosition);
    if (isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    confidentPairs.push({
      removedIndex,
      addedIndex,
      confidence: linePairConfidence(score, competingScore),
    });
  }
  return confidentPairs;
}

function competingChangedLineScore(
  scores: number[][],
  removedPosition: number,
  addedPosition: number,
  usedRemoved?: ReadonlySet<number>,
  usedAdded?: ReadonlySet<number>,
): number {
  return competingChangedLineScoreAt(
    scores.length,
    scores[removedPosition]?.length ?? 0,
    removedPosition,
    addedPosition,
    (candidateRemovedPosition, candidateAddedPosition) =>
      scores[candidateRemovedPosition]?.[candidateAddedPosition] ?? 0,
    usedRemoved,
    usedAdded,
  );
}

function addCrossingPairs(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  scores: number[][],
  positions: ChangedLinePositions,
  pairs: ChangedLinePair[],
): ChangedLinePair[] {
  const usedRemoved = new Set<number>();
  const usedAdded = new Set<number>();
  for (const pair of pairs) {
    const removedPosition = positions.removed.get(pair.removedIndex);
    const addedPosition = positions.added.get(pair.addedIndex);
    if (removedPosition !== undefined) usedRemoved.add(removedPosition);
    if (addedPosition !== undefined) usedAdded.add(addedPosition);
  }

  const candidates: ChangedLinePairCandidate[] = [];
  for (let removedPosition = 0; removedPosition < removed.length; removedPosition++) {
    if (usedRemoved.has(removedPosition)) continue;
    for (let addedPosition = 0; addedPosition < added.length; addedPosition++) {
      if (usedAdded.has(addedPosition)) continue;
      const score = scores[removedPosition]?.[addedPosition] ?? 0;
      if (score >= MIN_CHANGED_LINE_PAIR_SCORE)
        candidates.push({ removedPosition, addedPosition, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const competingScores = changedLineCompetingScores(scores);

  const out = [...pairs];
  for (const candidate of candidates) {
    if (usedRemoved.has(candidate.removedPosition) || usedAdded.has(candidate.addedPosition))
      continue;
    let confidence: WordChangeConfidence | undefined;
    if (candidate.score >= MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE) {
      const availableCompetingScore = competingChangedLineScore(
        scores,
        candidate.removedPosition,
        candidate.addedPosition,
        usedRemoved,
        usedAdded,
      );
      if (linePairConfidence(candidate.score, availableCompetingScore) === "high")
        confidence = "high";
    }
    confidence ??= reciprocalCrossingPairConfidence(competingScores, candidate);
    if (!confidence) continue;
    usedRemoved.add(candidate.removedPosition);
    usedAdded.add(candidate.addedPosition);
    out.push({
      removedIndex: changedLineAt(removed, candidate.removedPosition).index,
      addedIndex: changedLineAt(added, candidate.addedPosition).index,
      confidence,
    });
  }

  return out.toSorted(
    (a, b) =>
      (positions.removed.get(a.removedIndex) ?? 0) - (positions.removed.get(b.removedIndex) ?? 0),
  );
}

type ChangedLineCompetingScores = {
  removed: TopTwoCandidateValues[];
  added: TopTwoCandidateValues[];
};

function changedLineCompetingScores(scores: number[][]): ChangedLineCompetingScores {
  const removed: TopTwoCandidateValues[] = [];
  const added: TopTwoCandidateValues[] = [];
  for (let removedPosition = 0; removedPosition < scores.length; removedPosition++) {
    const removedScores = scores[removedPosition] ?? [];
    for (let addedPosition = 0; addedPosition < removedScores.length; addedPosition++) {
      const score = removedScores[addedPosition] ?? 0;
      addCandidateValue(removed, removedPosition, score);
      addCandidateValue(added, addedPosition, score);
    }
  }
  return { removed, added };
}

function addCandidateValue(values: TopTwoCandidateValues[], position: number, value: number): void {
  const current = values[position] ?? { best: 0, second: 0 };
  if (value >= current.best) {
    current.second = current.best;
    current.best = value;
  } else if (value > current.second) current.second = value;
  values[position] = current;
}

function reciprocalCrossingPairConfidence(
  competingScores: ChangedLineCompetingScores,
  candidate: ChangedLinePairCandidate,
): WordChangeConfidence | undefined {
  const competingScore = Math.max(
    competingCandidateValue(competingScores.removed[candidate.removedPosition], candidate.score),
    competingCandidateValue(competingScores.added[candidate.addedPosition], candidate.score),
  );
  if (!isReciprocalBestChangedLinePair(candidate.score, competingScore)) return undefined;
  return linePairConfidence(candidate.score, competingScore);
}

function addPositionalFallbackPairs(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  scores: number[][],
  similarPairs: ChangedLinePositionPair[],
): ChangedLineIndexPair[] {
  const pairs: ChangedLineIndexPair[] = [];
  let removedCursor = 0;
  let addedCursor = 0;
  for (const [removedPosition, addedPosition] of similarPairs) {
    pairs.push(
      ...positionPairs(
        removed,
        added,
        scores,
        removedCursor,
        removedPosition,
        addedCursor,
        addedPosition,
      ),
    );
    pairs.push([
      changedLineAt(removed, removedPosition).index,
      changedLineAt(added, addedPosition).index,
    ]);
    removedCursor = removedPosition + 1;
    addedCursor = addedPosition + 1;
  }
  pairs.push(
    ...positionPairs(
      removed,
      added,
      scores,
      removedCursor,
      removed.length,
      addedCursor,
      added.length,
    ),
  );
  return pairs;
}

function positionPairs(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
  scores: number[][],
  removedStart: number,
  removedEnd: number,
  addedStart: number,
  addedEnd: number,
): ChangedLineIndexPair[] {
  const pairs: ChangedLineIndexPair[] = [];
  const count = Math.min(removedEnd - removedStart, addedEnd - addedStart);
  for (let offset = 0; offset < count; offset++) {
    const removedPosition = removedStart + offset;
    const addedPosition = addedStart + offset;
    const score = scores[removedPosition]?.[addedPosition] ?? 0;
    if (score < MIN_POSITIONAL_FALLBACK_PAIR_SCORE) continue;
    pairs.push([
      changedLineAt(removed, removedPosition).index,
      changedLineAt(added, addedPosition).index,
    ]);
  }
  return pairs;
}
