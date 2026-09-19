import type { changedLineSimilarityDocuments, similarityTokenWeight } from "./line-similarity";
import { competingCandidateValue, topTwoCandidateValues } from "./line-pair-scoring";

export type SparseChangedLinePairCandidate = {
  removedPosition: number;
  addedPosition: number;
  evidence: number;
  sharedFeatureCount: number;
  hasUniqueFeature: boolean;
  competingEvidence: number;
};

const MAX_SPARSE_FEATURE_DOCUMENTS = 6;
const MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE = 3;
const MAX_SPARSE_CANDIDATES_PER_LINE = 8;
const MIN_SPARSE_RARE_FEATURE_COUNT = 2;
const MIN_SPARSE_EVIDENCE_MARGIN = 1;
const MIN_SPARSE_EVIDENCE_RATIO = 0.9;

export function sparseChangedLinePairCandidates(
  documents: ReturnType<typeof changedLineSimilarityDocuments>,
  tokenWeight: ReturnType<typeof similarityTokenWeight>,
): SparseChangedLinePairCandidate[] {
  const removedPositions = similarityFeaturePositions(documents.removedFeatures);
  const addedPositions = similarityFeaturePositions(documents.addedFeatures);
  const candidates = new Map<number, SparseChangedLinePairCandidate>();
  const addedLength = documents.addedFeatures.length;

  for (const [feature, featureRemovedPositions] of removedPositions) {
    const featureAddedPositions = addedPositions.get(feature);
    if (!featureAddedPositions) continue;
    const documentCount = documents.documentCounts.get(feature) ?? Number.POSITIVE_INFINITY;
    if (
      documentCount > MAX_SPARSE_FEATURE_DOCUMENTS ||
      featureRemovedPositions.length > MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE ||
      featureAddedPositions.length > MAX_SPARSE_FEATURE_DOCUMENTS_PER_SIDE
    )
      continue;
    const weight = tokenWeight(feature);
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
  addCompetingSparseEvidence(candidateList);
  return boundedSparseChangedLinePairCandidates(candidateList);
}

function similarityFeaturePositions(featureLists: string[][]): Map<string, number[]> {
  const positions = new Map<string, number[]>();
  for (let position = 0; position < featureLists.length; position++) {
    const features = featureLists[position];
    if (!features) continue;
    for (const feature of new Set(features)) {
      const featurePositions = positions.get(feature);
      if (featurePositions) featurePositions.push(position);
      else positions.set(feature, [position]);
    }
  }
  return positions;
}

function addCompetingSparseEvidence(candidates: SparseChangedLinePairCandidate[]): void {
  const removedEvidence = topTwoCandidateValues(
    candidates,
    (candidate) => candidate.removedPosition,
    (candidate) => candidate.evidence,
  );
  const addedEvidence = topTwoCandidateValues(
    candidates,
    (candidate) => candidate.addedPosition,
    (candidate) => candidate.evidence,
  );
  for (const candidate of candidates) {
    candidate.competingEvidence = Math.max(
      competingCandidateValue(removedEvidence.get(candidate.removedPosition), candidate.evidence),
      competingCandidateValue(addedEvidence.get(candidate.addedPosition), candidate.evidence),
    );
  }
}

function boundedSparseChangedLinePairCandidates(
  candidates: SparseChangedLinePairCandidate[],
): SparseChangedLinePairCandidate[] {
  const byRemoved = new Map<number, SparseChangedLinePairCandidate[]>();
  const byAdded = new Map<number, SparseChangedLinePairCandidate[]>();
  for (const candidate of candidates) {
    appendSparseCandidate(byRemoved, candidate.removedPosition, candidate);
    appendSparseCandidate(byAdded, candidate.addedPosition, candidate);
  }
  const selectedByRemoved = topSparseCandidates(byRemoved);
  const selectedByAdded = topSparseCandidates(byAdded);
  return candidates.filter(
    (candidate) => selectedByRemoved.has(candidate) && selectedByAdded.has(candidate),
  );
}

function appendSparseCandidate(
  candidates: Map<number, SparseChangedLinePairCandidate[]>,
  position: number,
  candidate: SparseChangedLinePairCandidate,
): void {
  const atPosition = candidates.get(position);
  if (atPosition) atPosition.push(candidate);
  else candidates.set(position, [candidate]);
}

function topSparseCandidates(
  candidates: Map<number, SparseChangedLinePairCandidate[]>,
): Set<SparseChangedLinePairCandidate> {
  const selected = new Set<SparseChangedLinePairCandidate>();
  for (const atPosition of candidates.values()) {
    atPosition.sort(compareSparseCandidates);
    for (const candidate of atPosition.slice(0, MAX_SPARSE_CANDIDATES_PER_LINE))
      selected.add(candidate);
  }
  return selected;
}

export function compareSparseCandidates(
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

export function hasStrongSparseEvidence(candidate: SparseChangedLinePairCandidate): boolean {
  if (!candidate.hasUniqueFeature && candidate.sharedFeatureCount < MIN_SPARSE_RARE_FEATURE_COUNT)
    return false;
  return (
    candidate.evidence - candidate.competingEvidence > MIN_SPARSE_EVIDENCE_MARGIN &&
    candidate.competingEvidence < candidate.evidence * MIN_SPARSE_EVIDENCE_RATIO
  );
}
