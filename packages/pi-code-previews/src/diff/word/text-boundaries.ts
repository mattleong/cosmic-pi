const NON_ASCII_TEXT_PATTERN = /\P{ASCII}/u;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
type GraphemeSegments = ReturnType<Intl.Segmenter["segment"]>;

export function commonPrefixLength(before: string, after: string): number {
  const prefix = commonPrefixCodeUnitLength(before, after);
  if (!needsBoundarySafeOffsets(before) && !needsBoundarySafeOffsets(after)) return prefix;
  return commonGraphemePrefixLength(before, after, prefix);
}

export function commonSuffixLength(before: string, after: string, prefixLength: number): number {
  const suffix = commonSuffixCodeUnitLength(before, after, prefixLength);
  if (!needsBoundarySafeOffsets(before) && !needsBoundarySafeOffsets(after)) return suffix;
  return commonGraphemeSuffixLength(before, after, suffix);
}

export function needsBoundarySafeOffsets(text: string): boolean {
  return NON_ASCII_TEXT_PATTERN.test(text) || text.includes("\r\n");
}

export function rangesAtGraphemeBoundaries(
  text: string,
  ranges: Array<[number, number]>,
): Array<[number, number]> {
  if (ranges.length === 0 || !needsBoundarySafeOffsets(text)) return ranges;

  const segmentedText = graphemeSegmenter.segment(text);
  return ranges.map(([start, end]) => [
    graphemeStartAtOrBefore(segmentedText, start, text.length),
    graphemeEndAtOrAfter(segmentedText, end, text.length),
  ]);
}

function commonPrefixCodeUnitLength(before: string, after: string): number {
  const end = Math.min(before.length, after.length);
  let index = 0;
  while (index < end && before[index] === after[index]) index++;
  return index;
}

function commonSuffixCodeUnitLength(before: string, after: string, prefixLength: number): number {
  const maxLength = Math.min(before.length, after.length) - prefixLength;
  let length = 0;
  while (
    length < maxLength &&
    before[before.length - 1 - length] === after[after.length - 1 - length]
  )
    length++;
  return length;
}

function commonGraphemePrefixLength(before: string, after: string, prefix: number): number {
  const beforeSegments = graphemeSegmenter.segment(before);
  const afterSegments = graphemeSegmenter.segment(after);
  let safePrefix = prefix;
  while (safePrefix > 0) {
    const nextPrefix = Math.min(
      graphemeStartAtOrBefore(beforeSegments, safePrefix, before.length),
      graphemeStartAtOrBefore(afterSegments, safePrefix, after.length),
    );
    if (nextPrefix === safePrefix) break;
    safePrefix = nextPrefix;
  }
  return safePrefix;
}

function commonGraphemeSuffixLength(before: string, after: string, suffix: number): number {
  const beforeSegments = graphemeSegmenter.segment(before);
  const afterSegments = graphemeSegmenter.segment(after);
  let safeSuffix = suffix;
  while (safeSuffix > 0) {
    const beforeStart = before.length - safeSuffix;
    const afterStart = after.length - safeSuffix;
    const beforeTrim =
      graphemeEndAtOrAfter(beforeSegments, beforeStart, before.length) - beforeStart;
    const afterTrim = graphemeEndAtOrAfter(afterSegments, afterStart, after.length) - afterStart;
    const trim = Math.max(beforeTrim, afterTrim);
    if (trim === 0) break;
    safeSuffix = Math.max(0, safeSuffix - trim);
  }
  return safeSuffix;
}

function graphemeStartAtOrBefore(
  segments: GraphemeSegments,
  offset: number,
  textLength: number,
): number {
  if (offset <= 0) return 0;
  if (offset >= textLength) return textLength;
  return segments.containing(offset)?.index ?? offset;
}

function graphemeEndAtOrAfter(
  segments: GraphemeSegments,
  offset: number,
  textLength: number,
): number {
  if (offset <= 0) return 0;
  if (offset >= textLength) return textLength;
  const segment = segments.containing(offset - 1);
  return segment ? segment.index + segment.segment.length : offset;
}
