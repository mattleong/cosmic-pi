import type { AddedDiffLine, RemovedDiffLine } from "../parse";
import { suffixAlignmentScore } from "./alignment";
import { wordEmphasisSimilarityTokenValues, wordEmphasisTokenWeight } from "./tokens";
import { changedLineTokens, type IndexedChangedLine } from "./changed-line";
import { requiredAt } from "./types";

type SimilarityTokenWeight = (token: string) => number;

/** One changed line's similarity features and their total IDF weight within its block. */
type SimilarityLine = { readonly features: string[]; readonly weight: number };

/** The similarity model of one changed block, shared by dense and sparse line matching. */
export type ChangedLineSimilarity = {
  readonly removed: SimilarityLine[];
  readonly added: SimilarityLine[];
  /** How many lines of the block contain each feature. */
  readonly documentCounts: ReadonlyMap<string, number>;
  readonly tokenWeight: SimilarityTokenWeight;
};

const SIMILARITY_BIGRAM_PREFIX = "\u0000PI_SIM_BIGRAM\u0000";
const MAX_LINE_TOKEN_SIMILARITY_CELLS = 16_384;

export function changedLineSimilarity(
  removed: Array<IndexedChangedLine<RemovedDiffLine>>,
  added: Array<IndexedChangedLine<AddedDiffLine>>,
): ChangedLineSimilarity {
  const lineFeatures = (line: IndexedChangedLine<AddedDiffLine | RemovedDiffLine>) =>
    similarityFeatures(wordEmphasisSimilarityTokenValues(changedLineTokens(line)));
  const removedFeatures = removed.map(lineFeatures);
  const addedFeatures = added.map(lineFeatures);
  const documentCounts = new Map<string, number>();
  for (const features of [...removedFeatures, ...addedFeatures]) {
    for (const feature of new Set(features))
      documentCounts.set(feature, (documentCounts.get(feature) ?? 0) + 1);
  }
  const lineCount = removed.length + added.length;
  const weights = new Map<string, number>();
  const tokenWeight = (token: string): number => {
    const cached = weights.get(token);
    if (cached !== undefined) return cached;
    const documentCount = documentCounts.get(token) ?? lineCount;
    const rarity = Math.min(3, 1 + Math.log((lineCount + 1) / (documentCount + 1)));
    const weight = baseSimilarityWeight(token) * rarity;
    weights.set(token, weight);
    return weight;
  };
  const similarityLine = (features: string[]): SimilarityLine => ({
    features,
    weight: similarityTokenListWeight(features, tokenWeight),
  });
  return {
    removed: removedFeatures.map(similarityLine),
    added: addedFeatures.map(similarityLine),
    documentCounts,
    tokenWeight,
  };
}

export function hasUniqueSharedSimilarityFeature(
  similarity: ChangedLineSimilarity,
  removedPosition: number,
  addedPosition: number,
): boolean {
  const addedFeatures = new Set(similarityLineAt(similarity.added, addedPosition).features);
  return similarityLineAt(similarity.removed, removedPosition).features.some(
    (feature) =>
      addedFeatures.has(feature) &&
      similarity.documentCounts.get(feature) === 2 &&
      baseSimilarityWeight(feature) >= 1,
  );
}

/** Order-insensitive overlap, the cheaper score sparse matching uses for large blocks. */
export function bagLineSimilarity(
  similarity: ChangedLineSimilarity,
  removedPosition: number,
  addedPosition: number,
): number {
  const before = similarityLineAt(similarity.removed, removedPosition);
  const after = similarityLineAt(similarity.added, addedPosition);
  return unorderedTokenSimilarity(
    before.features,
    after.features,
    similarity.tokenWeight,
    before.weight,
    after.weight,
  );
}

export function lineSimilarity(
  similarity: ChangedLineSimilarity,
  removedPosition: number,
  addedPosition: number,
  minimumRelevantSimilarity: number,
): number {
  const before = similarityLineAt(similarity.removed, removedPosition);
  const after = similarityLineAt(similarity.added, addedPosition);
  if (before.features.length === 0 || after.features.length === 0)
    return before.features.length === after.features.length ? 1 : 0;
  const bagSimilarity = bagLineSimilarity(similarity, removedPosition, addedPosition);
  // Ordered overlap cannot exceed multiset overlap. Avoid its dynamic program when
  // the upper bound is already below the caller's minimum useful score.
  if (bagSimilarity < minimumRelevantSimilarity) return bagSimilarity;
  const orderedSimilarity = orderedTokenSimilarity(before, after, similarity.tokenWeight);
  if (orderedSimilarity === undefined) return bagSimilarity;
  return Math.max(
    orderedSimilarity,
    bagSimilarity * 0.8,
    orderedSimilarity * 0.75 + bagSimilarity * 0.25,
  );
}

export function unorderedTokenSimilarity(
  beforeTokens: string[],
  afterTokens: string[],
  weight: SimilarityTokenWeight,
  beforeWeight = similarityTokenListWeight(beforeTokens, weight),
  afterWeight = similarityTokenListWeight(afterTokens, weight),
): number {
  const remaining = new Map<string, number>();
  for (const token of beforeTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  let sharedWeight = 0;
  for (const token of afterTokens) {
    const count = remaining.get(token) ?? 0;
    if (count === 0) continue;
    sharedWeight += weight(token);
    if (count === 1) remaining.delete(token);
    else remaining.set(token, count - 1);
  }
  return (2 * sharedWeight) / (beforeWeight + afterWeight);
}

function orderedTokenSimilarity(
  before: SimilarityLine,
  after: SimilarityLine,
  weight: SimilarityTokenWeight,
): number | undefined {
  const beforeTokens = before.features;
  const afterTokens = after.features;
  if (beforeTokens.length * afterTokens.length > MAX_LINE_TOKEN_SIMILARITY_CELLS) return undefined;
  const score = suffixAlignmentScore(
    beforeTokens.length,
    afterTokens.length,
    (beforeIndex, afterIndex) => {
      const beforeToken = requiredAt(beforeTokens, beforeIndex, "similarity token");
      return beforeToken === requiredAt(afterTokens, afterIndex, "similarity token")
        ? weight(beforeToken)
        : Number.NEGATIVE_INFINITY;
    },
  );

  return (2 * score) / (before.weight + after.weight);
}

function similarityLineAt(lines: SimilarityLine[], position: number): SimilarityLine {
  return requiredAt(lines, position, "similarity line");
}

function similarityFeatures(tokens: string[]): string[] {
  const features = [...tokens];
  const weighted = tokens.filter((token) => wordEmphasisTokenWeight(token) >= 1);
  for (let index = 0; index + 2 <= weighted.length; index++)
    features.push(`${SIMILARITY_BIGRAM_PREFIX}${weighted.slice(index, index + 2).join("\u0000")}`);
  return features;
}

function similarityTokenListWeight(tokens: string[], weight: SimilarityTokenWeight): number {
  return tokens.reduce((total, token) => total + weight(token), 0);
}

/** Weight before rarity scaling; feature bigrams count slightly more than single tokens. */
function baseSimilarityWeight(token: string): number {
  if (token.startsWith(SIMILARITY_BIGRAM_PREFIX)) return 1.15;
  return wordEmphasisTokenWeight(token);
}
