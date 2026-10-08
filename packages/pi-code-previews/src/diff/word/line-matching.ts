import { requiredAt, type WordChangeConfidence } from "./types";
import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { prefixAlignedPairs } from "./alignment";
import {
  changedLineSimilarity,
  lineSimilarity,
  type ChangedLineSimilarity,
} from "./line-similarity";
import type { IndexedChangedLine } from "./changed-line";
import {
  competingCandidateValues,
  competingChangedLineScores,
  isAmbiguousChangedLinePairScore,
  isReciprocalBestChangedLinePair,
  linePairConfidence,
  MIN_CHANGED_LINE_PAIR_SCORE,
  MIN_HIGH_CONFIDENCE_CROSSING_PAIR_SCORE,
  MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
  type ChangedLinePositionMatch,
  type ChangedLineScoreAt,
  type CompetingChangedLineScoreAt,
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
  const similarity = changedLineSimilarity(removed, added);
  const pairs =
    removed.length * added.length > MAX_CHANGED_LINE_PAIR_CELLS
      ? matchChangedLinesSparse(similarity)
      : matchChangedLinesDense(similarity);
  return pairs
    .toSorted((a, b) => a.removedPosition - b.removedPosition)
    .map(({ removedPosition, addedPosition, confidence }) => ({
      removedIndex: requiredAt(removed, removedPosition, "changed line").index,
      addedIndex: requiredAt(added, addedPosition, "changed line").index,
      confidence,
    }));
}

const MAX_CHANGED_LINE_PAIR_CELLS = 1024;

function matchChangedLinesDense(similarity: ChangedLineSimilarity): ChangedLinePositionMatch[] {
  const removedLength = similarity.removed.length;
  const addedLength = similarity.added.length;
  const scores = similarity.removed.map((_removedLine, removedPosition) =>
    similarity.added.map((_addedLine, addedPosition) =>
      lineSimilarity(
        similarity,
        removedPosition,
        addedPosition,
        MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
      ),
    ),
  );
  const scoreAt: ChangedLineScoreAt = (removedPosition, addedPosition) =>
    scores[removedPosition]?.[addedPosition] ?? 0;
  const competingScoreAt = competingChangedLineScores(removedLength, addedLength, scoreAt);
  const similarPairs = prefixAlignedPairs(
    removedLength,
    addedLength,
    (removedPosition, addedPosition) => {
      const score = scoreAt(removedPosition, addedPosition);
      return score >= MIN_CHANGED_LINE_PAIR_SCORE ? score + 0.01 : Number.NEGATIVE_INFINITY;
    },
  );
  if (similarPairs.length === 0 && removedLength === 1 && addedLength === 1)
    return [{ removedPosition: 0, addedPosition: 0, confidence: "medium" }];
  const confidentPairs: ChangedLinePositionMatch[] = [];
  for (const [removedPosition, addedPosition] of positionalFallbackPairs(
    removedLength,
    addedLength,
    scoreAt,
    similarPairs,
  )) {
    const score = scoreAt(removedPosition, addedPosition);
    const competingScore = competingScoreAt(removedPosition, addedPosition);
    if (isAmbiguousChangedLinePairScore(score, competingScore)) continue;
    confidentPairs.push({
      removedPosition,
      addedPosition,
      confidence: linePairConfidence(score, competingScore),
    });
  }
  return addCrossingPairs(scores, confidentPairs, competingScoreAt);
}

function addCrossingPairs(
  scores: number[][],
  pairs: ChangedLinePositionMatch[],
  competingScoreAt: CompetingChangedLineScoreAt,
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
      const availableCompetingScore = competingScoreAt(
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
  scoreAt: ChangedLineScoreAt,
  similarPairs: ChangedLinePositionPair[],
): ChangedLinePositionPair[] {
  const pairs: ChangedLinePositionPair[] = [];
  const anchors: ChangedLinePositionPair[] = [...similarPairs, [removedLength, addedLength]];
  let removedCursor = 0;
  let addedCursor = 0;
  for (const [removedPosition, addedPosition] of anchors) {
    const count = Math.min(removedPosition - removedCursor, addedPosition - addedCursor);
    for (let offset = 0; offset < count; offset++) {
      const pair: ChangedLinePositionPair = [removedCursor + offset, addedCursor + offset];
      if (scoreAt(...pair) >= MIN_POSITIONAL_FALLBACK_PAIR_SCORE) pairs.push(pair);
    }
    if (removedPosition < removedLength) pairs.push([removedPosition, addedPosition]);
    removedCursor = removedPosition + 1;
    addedCursor = addedPosition + 1;
  }
  return pairs;
}
