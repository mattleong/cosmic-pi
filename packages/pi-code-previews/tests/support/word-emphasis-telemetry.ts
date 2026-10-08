import type { DiffWordEmphasis } from "../../src/config/schema";
import { splitLinesLimited } from "../../src/shared/text-lines";
import { changedDiffBlocks, parseDiffLine, type ParsedDiffLine } from "../../src/diff/parse";
import { analyzeChangedLineBlock } from "../../src/diff/word/change-block";
import { shouldEmphasizeChangedPair } from "../../src/diff/word/emphasis";
import type { WordChangeConfidence } from "../../src/diff/word/types";

type WordEmphasisTelemetry = {
  changedBlocks: number;
  changedLines: { removed: number; added: number };
  pairConfidence: Record<WordChangeConfidence, number>;
  rangeConfidence: Record<WordChangeConfidence, number>;
  emphasizedPairs: number;
  skippedPairs: number;
  skippedPotentialPairs: number;
};

export function wordEmphasisTelemetry(
  diff: string,
  limit = Number.MAX_SAFE_INTEGER,
  wordEmphasis: DiffWordEmphasis = "smart",
): WordEmphasisTelemetry {
  const parsedLines = splitLinesLimited(diff, limit).map(parseDiffLine);
  const telemetry = emptyWordEmphasisTelemetry();
  for (const [start, end] of changedDiffBlocks(parsedLines))
    addChangeBlockTelemetry(parsedLines.slice(start, end), telemetry, wordEmphasis);
  return telemetry;
}

function emptyWordEmphasisTelemetry(): WordEmphasisTelemetry {
  return {
    changedBlocks: 0,
    changedLines: { removed: 0, added: 0 },
    pairConfidence: { high: 0, medium: 0, low: 0 },
    rangeConfidence: { high: 0, medium: 0, low: 0 },
    emphasizedPairs: 0,
    skippedPairs: 0,
    skippedPotentialPairs: 0,
  };
}

function addChangeBlockTelemetry(
  block: Array<ParsedDiffLine | null>,
  telemetry: WordEmphasisTelemetry,
  wordEmphasis: DiffWordEmphasis,
): void {
  const analysis = analyzeChangedLineBlock(block, wordEmphasis);
  telemetry.changedBlocks++;
  telemetry.changedLines.removed += analysis.removed.length;
  telemetry.changedLines.added += analysis.added.length;
  telemetry.skippedPotentialPairs += Math.max(
    0,
    Math.min(analysis.removed.length, analysis.added.length) - analysis.pairs.length,
  );

  for (const pair of analysis.pairs) telemetry.pairConfidence[pair.confidence]++;
  for (const { pair, ranges } of analysis.ranges) {
    telemetry.rangeConfidence[ranges.confidence]++;
    if (shouldEmphasizeChangedPair(ranges, pair.confidence)) telemetry.emphasizedPairs++;
    else telemetry.skippedPairs++;
  }
}
