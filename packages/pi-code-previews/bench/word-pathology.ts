// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
import type { DiffWordEmphasis } from "../src/config/schema";
import { renderSyntaxHighlightedDiff } from "../src/diff/render";
import { wordEmphasisTelemetry } from "../src/testing/word-emphasis-telemetry";
import { changedRanges, changedRangesWithConfidence } from "../src/diff/word/emphasis";
import { profileLine, profilePlacement } from "../src/diff/word/fixtures/profile-lines";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import {
  benchLog,
  benchTable,
  benchTheme,
  formatDuration,
  formatMs,
  printBenchHeader,
  printLayerSummary,
  printResults,
  runBench,
} from "./helpers";

let sink = 0;
const theme = benchTheme();
const previousSettings = { ...codePreviewSettings };
const MODES: DiffWordEmphasis[] = ["smart", "all"];

type WordCase = {
  name: string;
  before: string;
  after: string;
};

type PairingCase = {
  name: string;
  diff: string;
  lines: number;
};

try {
  printBenchHeader("word-emphasis and changed-line pathology");
  setCodePreviewSettings({
    ...codePreviewSettings,
    syntaxHighlighting: false,
    wordEmphasis: "smart",
  });

  const results = [];
  for (const benchCase of makeWordCases()) {
    for (const mode of MODES) {
      setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: mode });
      results.push(
        runBench(benchCase.name, "changedRanges", mode, () => {
          const ranges = changedRanges(benchCase.before, benchCase.after, mode);
          sink += ranges.removed.length + ranges.added.length;
        }),
      );
    }
  }

  for (const benchCase of makePairingCases()) {
    for (const mode of ["off", "smart"] as const) {
      setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: mode });
      results.push(
        runBench(benchCase.name, "renderChangedBlock", mode, () => {
          sink += renderSyntaxHighlightedDiff(
            benchCase.diff,
            "typescript",
            theme,
            benchCase.lines,
          ).length;
        }),
      );
    }
  }

  printLayerSummary(results);
  printOverheadSummary(results);
  printConfidenceSummary(makeWordCases(), makePairingCases());
  benchLog("changedRanges cases target weighted exact LCS and anchor fallback paths.");
  benchLog("renderChangedBlock cases target exact and positional fallback changed-line pairing.");
  benchLog("");
  printResults(results);
  if (sink === Number.MIN_SAFE_INTEGER) benchLog("sink", sink);
} finally {
  setCodePreviewSettings(previousSettings);
}

function makeWordCases(): WordCase[] {
  return [
    {
      name: "token weighted LCS boundary 512x512 reversed",
      before: numberedTokens("tok", 512).join(" "),
      after: numberedTokens("tok", 512).toReversed().join(" "),
    },
    {
      name: "token anchor fallback 513x513 reversed",
      before: numberedTokens("tok", 513).join(" "),
      after: numberedTokens("tok", 513).toReversed().join(" "),
    },
    {
      name: "repeated tokens no unique anchors fallback",
      before: repeatedTokens("before", 520),
      after: repeatedTokens("after", 520),
    },
    {
      name: "very long identifier refinement",
      before: `const ${longIdentifier("Old", 28)} = source.${longIdentifier("Value", 24)};`,
      after: `const ${longIdentifier("New", 28)} = target.${longIdentifier("Value", 24)};`,
    },
    {
      name: "identifier separator deletion",
      before: "snake_case",
      after: "snakecase",
    },
    {
      name: "wrapper syntax smart-filter noise",
      before: "  .map((item) => item.title)",
      after: "  (item) => item.title",
    },
    {
      name: "bounded internal token refinement",
      before: "fooaabarbbbaz",
      after: "fooxxbarzzbaz",
    },
    {
      name: "extended grapheme refinement",
      before: "const avatar = '👩🏽‍💻';",
      after: "const avatar = '👩🏻‍💻';",
    },
    {
      name: "Unicode comparison smart-filter signal",
      before: "if (count ≤ limit)",
      after: "if (count ≥ limit)",
    },
    {
      name: "long non-ASCII grapheme snapping",
      before: `${"é".repeat(10_000)}Old`,
      after: `${"é".repeat(10_000)}New`,
    },
  ];
}

function makePairingCases(): PairingCase[] {
  return [
    { name: "line pairing exact boundary 32x32", ...pairingDiff(32, similarBefore, similarAfter) },
    {
      name: "line pairing unique reordered exact 32x32",
      ...reorderedPairingDiff(32),
    },
    {
      name: "line pairing fallback boundary 33x33",
      ...pairingDiff(33, similarBefore, similarAfter),
    },
    {
      name: "line pairing unique reordered sparse 33x33",
      ...reorderedPairingDiff(33),
    },
    {
      name: "line pairing shifted sparse 32x33",
      ...shiftedPairingDiff(32),
    },
    { name: "line pairing fallback 100x100", ...pairingDiff(100, similarBefore, similarAfter) },
    {
      name: "line pairing unique reordered sparse 100x100",
      ...reorderedPairingDiff(100),
    },
    {
      name: "line pairing medium reordered sparse 100x100",
      ...mediumReorderedPairingDiff(100),
    },
    {
      name: "line pairing repeated reordered 32x32",
      ...pairingDiff(32, repeatedBefore, repeatedAfter),
    },
  ];
}

function printOverheadSummary(
  results: Array<{ caseName: string; layer: string; mode: string; meanMs: number }>,
): void {
  const rows = makePairingCases().map((benchCase) => {
    const off = findResult(results, benchCase.name, "renderChangedBlock", "off");
    const smart = findResult(results, benchCase.name, "renderChangedBlock", "smart");
    const overhead = off && smart ? Math.max(0, smart.meanMs - off.meanMs) : 0;
    return {
      case: benchCase.name,
      "off mean": off ? `${formatMs(off.meanMs)}ms` : "?",
      "smart mean": smart ? `${formatMs(smart.meanMs)}ms` : "?",
      "smart overhead": formatDuration(overhead),
    };
  });
  benchLog("Changed-line pairing overhead summary");
  benchTable(rows);
  benchLog("");
}

function printConfidenceSummary(wordCases: WordCase[], pairingCases: PairingCase[]): void {
  setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: "smart" });
  benchLog("Word emphasis confidence summary");
  benchTable(
    wordCases.map((benchCase) => {
      const ranges = changedRangesWithConfidence(benchCase.before, benchCase.after, "smart");
      return {
        case: benchCase.name,
        confidence: ranges.confidence,
        removedRanges: ranges.removed.length,
        addedRanges: ranges.added.length,
      };
    }),
  );
  benchLog("Changed-line pair confidence summary");
  benchTable(
    pairingCases.map((benchCase) => {
      const telemetry = wordEmphasisTelemetry(benchCase.diff, benchCase.lines, "smart");
      return {
        case: benchCase.name,
        pairs: telemetry.emphasizedPairs,
        skipped: telemetry.skippedPairs + telemetry.skippedPotentialPairs,
        pairHigh: telemetry.pairConfidence.high,
        pairMedium: telemetry.pairConfidence.medium,
        pairLow: telemetry.pairConfidence.low,
        rangeHigh: telemetry.rangeConfidence.high,
        rangeMedium: telemetry.rangeConfidence.medium,
        rangeLow: telemetry.rangeConfidence.low,
      };
    }),
  );
  benchLog("");
}

function findResult(
  results: Array<{ caseName: string; layer: string; mode: string; meanMs: number }>,
  caseName: string,
  layer: string,
  mode: string,
): { meanMs: number } | undefined {
  return results.find(
    (result) => result.caseName === caseName && result.layer === layer && result.mode === mode,
  );
}

function pairingDiff(
  count: number,
  before: (index: number) => string,
  after: (index: number) => string,
) {
  const lines = [
    ...Array.from({ length: count }, (_, index) => `- ${index + 1} ${before(index)}`),
    ...Array.from({ length: count }, (_, index) => `+ ${index + 1} ${after(index)}`),
  ];
  return { diff: lines.join("\n"), lines: lines.length };
}

function reorderedPairingDiff(count: number): { diff: string; lines: number } {
  return pairingDiff(
    count,
    (index) => `const item${index} = transform${index}(old${index});`,
    (index) => {
      const reversed = count - 1 - index;
      return `const item${reversed} = transform${reversed}(new${reversed});`;
    },
  );
}

function mediumReorderedPairingDiff(count: number): { diff: string; lines: number } {
  return pairingDiff(
    count,
    (position) => profileLine(position, profilePlacement(position, count), "removed"),
    (position) => profileLine(count - position - 1, profilePlacement(position, count), "added"),
  );
}

function shiftedPairingDiff(count: number) {
  const lines = [
    ...Array.from(
      { length: count },
      (_, index) => `- ${index + 1} const item${index} = transform${index}(old${index});`,
    ),
    "+ 1 const insertedOnly = initializeNewPath();",
    ...Array.from(
      { length: count },
      (_, index) => `+ ${index + 2} const item${index} = transform${index}(new${index});`,
    ),
  ];
  return { diff: lines.join("\n"), lines: lines.length };
}

function similarBefore(index: number): string {
  return `const value${index} = source.oldName${index % 5}(input${index}) ?? fallback${index};`;
}

function similarAfter(index: number): string {
  return `const value${index} = target.newName${index % 5}(safeInput${index}) ?? fallback${index};`;
}

function repeatedBefore(index: number): string {
  return `items.map((item) => item.shared${index % 4}).filter(Boolean) // old ${index % 3}`;
}

function repeatedAfter(index: number): string {
  const reversed = 31 - index;
  return `items.map((item) => item.shared${reversed % 4}).filter(Boolean) // new ${reversed % 3}`;
}

function numberedTokens(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function repeatedTokens(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index % 7}`).join(" ");
}

function longIdentifier(marker: string, parts: number): string {
  return Array.from({ length: parts }, (_, index) => `${marker}Segment${index}`).join("");
}
