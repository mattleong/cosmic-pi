import type { WordChangeConfidence } from "./types";
import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { prefixAlignedPairs } from "./alignment";
import {
  changedLineSimilarityDocuments,
  similarityTokenListWeight,
  similarityTokenWeight,
  tokenSimilarity,
} from "./line-similarity";
import { changedLineAt, type IndexedChangedLine } from "./changed-line";
import {
  competingCandidateValues,
  competingChangedLineScoreAt,
  isAmbiguousChangedLinePairScore,
  isReciprocalBestChangedLinePair,
  linePairConfidence,
  MIN_CHANGED_LINE_PAIR_SCORE,
  MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE,
  MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
  type ChangedLinePositionMatch,
} from "./line-pair-scoring";
import { matchChangedLinesSparse } from "./sparse-line-matching";

export type ChangedLinePair = {
  removedIndex: number;
  addedIndex: number;
  confidence: WordChangeConfidence;
};

type ChangedLinePositionPair = [removedPosition: number, addedPosition: number];

export function matchChangedLines(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePair[] {
  if (removed.length === 0 || added.length === 0) return [];
  const pairs =
    removed.length * added.length > MAX_CHANGED_LINE_PAIR_CELLS
      ? matchChangedLinesSparse(removed, added)
      : matchChangedLinesDense(removed, added);
  return pairs
    .toSorted((a, b) => a.removedPosition - b.removedPosition)
    .map(({ removedPosition, addedPosition, confidence }) => ({
      removedIndex: changedLineAt(removed, removedPosition).index,
      addedIndex: changedLineAt(added, addedPosition).index,
      confidence,
    }));
}

const MAX_CHANGED_LINE_PAIR_CELLS = 1024;

function matchChangedLinesDense(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLinePositionMatch[] {
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
    return [{ removedPosition: 0, addedPosition: 0, confidence: "medium" }];
  const confidentPairs = confidentChangedLinePairs(
    scores,
    positionalFallbackPairs(removed.length, added.length, scores, similarPairs),
  );
  return addCrossingPairs(scores, confidentPairs);
}

function confidentChangedLinePairs(
  scores: number[][],
  pairs: ChangedLinePositionPair[],
): ChangedLinePositionMatch[] {
  const confidentPairs: ChangedLinePositionMatch[] = [];
  for (const [removedPosition, addedPosition] of pairs) {
    const score = scores[removedPosition]?.[addedPosition] ?? 0;
    const competingScore = competingChangedLineScore(scores, removedPosition, addedPosition);
    if (isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    confidentPairs.push({
      removedPosition,
      addedPosition,
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
  scores: number[][],
  pairs: ChangedLinePositionMatch[],
): ChangedLinePositionMatch[] {
  const usedRemoved = new Set(pairs.map((pair) => pair.removedPosition));
  const usedAdded = new Set(pairs.map((pair) => pair.addedPosition));
  const cells = scores.flatMap((row, removedPosition) =>
    row.map((score, addedPosition) => ({ removedPosition, addedPosition, score })),
  );
  const candidates = cells
    .filter(
      (cell) =>
        !usedRemoved.has(cell.removedPosition) &&
        !usedAdded.has(cell.addedPosition) &&
        cell.score >= MIN_CHANGED_LINE_PAIR_SCORE,
    )
    .toSorted((a, b) => b.score - a.score);
  const reciprocalCompetingScore = competingCandidateValues(cells, (cell) => cell.score);

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
    if (!confidence) {
      const competingScore = reciprocalCompetingScore(candidate);
      if (isReciprocalBestChangedLinePair(candidate.score, competingScore))
        confidence = linePairConfidence(candidate.score, competingScore);
    }
    if (!confidence) continue;
    usedRemoved.add(candidate.removedPosition);
    usedAdded.add(candidate.addedPosition);
    out.push({
      removedPosition: candidate.removedPosition,
      addedPosition: candidate.addedPosition,
      confidence,
    });
  }
  return out;
}

function positionalFallbackPairs(
  removedLength: number,
  addedLength: number,
  scores: number[][],
  similarPairs: ChangedLinePositionPair[],
): ChangedLinePositionPair[] {
  const pairs: ChangedLinePositionPair[] = [];
  const anchors: ChangedLinePositionPair[] = [...similarPairs, [removedLength, addedLength]];
  let removedCursor = 0;
  let addedCursor = 0;
  for (const [removedPosition, addedPosition] of anchors) {
    const count = Math.min(removedPosition - removedCursor, addedPosition - addedCursor);
    for (let offset = 0; offset < count; offset++) {
      const score = scores[removedCursor + offset]?.[addedCursor + offset] ?? 0;
      if (score < MIN_POSITIONAL_FALLBACK_PAIR_SCORE) continue;
      pairs.push([removedCursor + offset, addedCursor + offset]);
    }
    if (removedPosition < removedLength) pairs.push([removedPosition, addedPosition]);
    removedCursor = removedPosition + 1;
    addedCursor = addedPosition + 1;
  }
  return pairs;
}
