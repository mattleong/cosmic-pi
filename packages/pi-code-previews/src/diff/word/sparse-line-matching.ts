import {
  bagLineSimilarity,
  hasUniqueSharedSimilarityFeature,
  type ChangedLineSimilarity,
} from "./line-similarity";
import {
  competingCandidateValues,
  competingChangedLineScores,
  isAmbiguousChangedLinePairScore,
  isReciprocalBestChangedLinePair,
  linePairConfidence,
  MIN_CHANGED_LINE_PAIR_SCORE,
  MIN_POSITIONAL_FALLBACK_PAIR_SCORE,
  type ChangedLineScoreAt,
  type ChangedLinePositionMatch,
} from "./line-pair-scoring";

type SparseChangedLinePairCandidate = {
  removedPosition: number;
  addedPosition: number;
  evidence: number;
  sharedFeatureCount: number;
  hasUniqueFeature: boolean;
  competingEvidence: number;
};

const MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS = 10_000;
const MAX_SPARSE_FEATURE_DOCUMENTS = 6;
const MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE = 3;
const MAX_SPARSE_CANDIDATES_PER_LINE = 8;
const MIN_SPARSE_RARE_FEATURE_COUNT = 2;
const MIN_SPARSE_EVIDENCE_MARGIN = 1;
const MIN_SPARSE_EVIDENCE_RATIO = 0.9;

/**
 * Matches blocks too large for a full score matrix: rare shared features propose candidate
 * pairs, reciprocal-best anchors are accepted, and unanchored lines fall back to their diagonal.
 */
export function matchChangedLinesSparse(
  similarity: ChangedLineSimilarity,
): ChangedLinePositionMatch[] {
  const removedLength = similarity.removed.length;
  const addedLength = similarity.added.length;
  const canCheckAmbiguity = removedLength * addedLength <= MAX_POSITIONAL_FALLBACK_AMBIGUITY_CELLS;
  const scoreCache = canCheckAmbiguity ? new Map<number, number>() : undefined;
  const scoreAt: ChangedLineScoreAt = (removedPosition, addedPosition) => {
    const key = removedPosition * addedLength + addedPosition;
    const cached = scoreCache?.get(key);
    if (cached !== undefined) return cached;
    const score = bagLineSimilarity(similarity, removedPosition, addedPosition);
    scoreCache?.set(key, score);
    return score;
  };
  const competingScoreAt = competingChangedLineScores(removedLength, addedLength, scoreAt);

  const pairs = sparseChangedLineAnchors(similarity, scoreAt);
  const usedRemoved = new Set(pairs.map((pair) => pair.removedPosition));
  const usedAdded = new Set(pairs.map((pair) => pair.addedPosition));

  for (let index = 0; index < Math.min(removedLength, addedLength); index++) {
    if (usedRemoved.has(index) || usedAdded.has(index)) continue;
    const score = scoreAt(index, index);
    if (score < MIN_POSITIONAL_FALLBACK_PAIR_SCORE) continue;
    let competingScore = 0;
    if (!hasUniqueSharedSimilarityFeature(similarity, index, index)) {
      if (!canCheckAmbiguity) continue;
      competingScore = competingScoreAt(index, index);
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
  similarity: ChangedLineSimilarity,
  scoreAt: ChangedLineScoreAt,
): ChangedLinePositionMatch[] {
  const scoredCandidates = sparseChangedLinePairCandidates(similarity)
    .map((candidate) =>
      Object.assign(candidate, {
        score: scoreAt(candidate.removedPosition, candidate.addedPosition),
      }),
    )
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
      sparsePositionalCompetingScore(candidate, similarity, scoreAt),
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

/** An off-diagonal anchor competes with the diagonal partners of both of its lines. */
function sparsePositionalCompetingScore(
  { removedPosition, addedPosition }: SparseChangedLinePairCandidate,
  similarity: ChangedLineSimilarity,
  scoreAt: ChangedLineScoreAt,
): number {
  if (removedPosition === addedPosition) return 0;
  return Math.max(
    removedPosition < similarity.added.length ? scoreAt(removedPosition, removedPosition) : 0,
    addedPosition < similarity.removed.length ? scoreAt(addedPosition, addedPosition) : 0,
  );
}

function sparseChangedLinePairCandidates(
  similarity: ChangedLineSimilarity,
): SparseChangedLinePairCandidate[] {
  const removedPositions = similarityFeaturePositions(similarity.removed);
  const addedPositions = similarityFeaturePositions(similarity.added);
  const candidates = new Map<number, SparseChangedLinePairCandidate>();
  const addedLength = similarity.added.length;

  for (const [feature, featureRemovedPositions] of removedPositions) {
    const featureAddedPositions = addedPositions.get(feature);
    if (!featureAddedPositions) continue;
    const documentCount = similarity.documentCounts.get(feature) ?? Number.POSITIVE_INFINITY;
    if (
      documentCount > MAX_SPARSE_FEATURE_DOCUMENTS ||
      featureRemovedPositions.length > MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE ||
      featureAddedPositions.length > MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE
    )
      continue;
    const weight = similarity.tokenWeight(feature);
    if (weight < 1) continue;
    const uniqueFeature =
      documentCount === 2 &&
      featureRemovedPositions.length === 1 &&
      featureAddedPositions.length === 1;

    for (const removedPosition of featureRemovedPositions) {
      for (const addedPosition of featureAddedPositions) {
        const key = removedPosition * addedLength + addedPosition;
        const candidate = candidates.get(key);
        if (candidate) {
          candidate.evidence += weight;
          candidate.sharedFeatureCount++;
          candidate.hasUniqueFeature ||= uniqueFeature;
        } else {
          candidates.set(key, {
            removedPosition,
            addedPosition,
            evidence: weight,
            sharedFeatureCount: 1,
            hasUniqueFeature: uniqueFeature,
            competingEvidence: 0,
          });
        }
      }
    }
  }

  const candidateList = [...candidates.values()];
  const competingEvidence = competingCandidateValues(
    candidateList,
    (candidate) => candidate.evidence,
  );
  for (const candidate of candidateList) candidate.competingEvidence = competingEvidence(candidate);
  const selectedByRemoved = topSparseCandidates(candidateList, (c) => c.removedPosition);
  const selectedByAdded = topSparseCandidates(candidateList, (c) => c.addedPosition);
  return candidateList.filter(
    (candidate) => selectedByRemoved.has(candidate) && selectedByAdded.has(candidate),
  );
}

function similarityFeaturePositions(
  lines: ChangedLineSimilarity["removed"],
): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  lines.forEach(({ features }, position) => {
    for (const feature of new Set(features)) appendAt(positions, feature, position);
  });
  return positions;
}

/** The strongest candidates of each line on one side, keyed by that side's position. */
function topSparseCandidates(
  candidates: SparseChangedLinePairCandidate[],
  position: (candidate: SparseChangedLinePairCandidate) => number,
): Set<SparseChangedLinePairCandidate> {
  const byPosition = new Map<number, SparseChangedLinePairCandidate[]>();
  for (const candidate of candidates) appendAt(byPosition, position(candidate), candidate);
  return new Set(
    [...byPosition.values()].flatMap((atPosition) =>
      atPosition.toSorted(compareSparseCandidates).slice(0, MAX_SPARSE_CANDIDATES_PER_LINE),
    ),
  );
}

function appendAt<K, V>(groups: Map<K, V[]>, key: K, value: V): void {
  const group = groups.get(key);
  if (group) group.push(value);
  else groups.set(key, [value]);
}

function compareSparseCandidates(
  a: SparseChangedLinePairCandidate,
  b: SparseChangedLinePairCandidate,
): number {
  return (
    Number(b.hasUniqueFeature) - Number(a.hasUniqueFeature) ||
    b.evidence - a.evidence ||
    b.sharedFeatureCount - a.sharedFeatureCount ||
    Math.abs(a.removedPosition - a.addedPosition) - Math.abs(b.removedPosition - b.addedPosition) ||
    a.removedPosition - b.removedPosition ||
    a.addedPosition - b.addedPosition
  );
}

function hasStrongSparseEvidence(candidate: SparseChangedLinePairCandidate): boolean {
  if (!candidate.hasUniqueFeature && candidate.sharedFeatureCount < MIN_SPARSE_RARE_FEATURE_COUNT)
    return false;
  return (
    candidate.evidence - candidate.competingEvidence > MIN_SPARSE_EVIDENCE_MARGIN &&
    candidate.competingEvidence < candidate.evidence * MIN_SPARSE_EVIDENCE_RATIO
  );
}
