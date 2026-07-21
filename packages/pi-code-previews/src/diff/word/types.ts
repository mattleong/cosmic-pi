export type WordChangeRanges = {
  removed: Array<[number, number]>;
  added: Array<[number, number]>;
};

export type WordChangeConfidence = "high" | "medium" | "low";

export type ConfidentWordChangeRanges = WordChangeRanges & {
  confidence: WordChangeConfidence;
};

export function hasWordChangeRanges(ranges: WordChangeRanges): boolean {
  return ranges.removed.length > 0 || ranges.added.length > 0;
}
