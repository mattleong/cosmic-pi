export type TextRange = [start: number, end: number];

export type WordChangeRanges = { removed: TextRange[]; added: TextRange[] };

export type WordChangeConfidence = "high" | "medium" | "low";

export type ConfidentWordChangeRanges = WordChangeRanges & {
  confidence: WordChangeConfidence;
};

export function hasWordChangeRanges(ranges: WordChangeRanges): boolean {
  return ranges.removed.length > 0 || ranges.added.length > 0;
}

export function requiredAt<T>(values: ArrayLike<T>, index: number, label: string): T {
  const value = values[index];
  if (value === undefined) throw new RangeError(`Missing ${label} ${index}`);
  return value;
}
