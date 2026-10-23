import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import * as Option from "effect/Option";
import type { DiffWordEmphasis } from "../src/config/schema";
import {
  benchLog,
  benchTable,
  benchTheme,
  formatDuration,
  formatMs,
  isEnabled,
  numberedLines,
  printBenchHeader,
  runBench as runSharedBench,
  timeOnce,
  type BenchResult as SharedBenchResult,
} from "./helpers";

const { renderSyntaxHighlightedDiff } = await import("../src/diff/render");
const { changedRangesWithConfidence } = await import("../src/diff/word/emphasis");
const { codePreviewSettings, setCodePreviewSettings } = await import("../src/config/state");
const { startBenchmarkShikiSession } = await import("./shiki-session");

type BenchCase = {
  name: string;
  lang?: string;
  diff: string;
  before: string;
  after: string;
  rangePairs: Array<{ before: string; after: string }>;
  limit: number;
};

type BenchLayer = "render/plain" | "render/highlight" | "word-ranges";

type BenchResult = SharedBenchResult & {
  layer: BenchLayer;
  name: string;
};

type LargeScenario = {
  name: string;
  baseCase: string;
  pairCounts: number[];
  makePair: (index: number) => { before: string; after: string };
};

const MODES: DiffWordEmphasis[] = ["off", "smart", "all"];
const VERBOSE = isEnabled("BENCH_VERBOSE");
const LARGE_ACTUAL = isEnabled("BENCH_LARGE_ACTUAL");
let sink = 0;

const cases = makeCases();
const largeScenarios = makeLargeScenarios();
const previousSettings = { ...codePreviewSettings };

const stopShiki = await startBenchmarkShikiSession(codePreviewSettings.shikiTheme);
try {
  printBenchHeader("diff rendering");

  const results: BenchResult[] = [];
  for (const benchCase of cases) {
    for (const mode of MODES) {
      setCodePreviewSettings({
        ...codePreviewSettings,
        wordEmphasis: mode,
        syntaxHighlighting: false,
      });
      results.push(
        runBench(benchCase.name, "render/plain", mode, () => {
          sink += renderSyntaxHighlightedDiff(
            benchCase.diff,
            undefined,
            benchTheme(),
            benchCase.limit,
          ).length;
        }),
      );

      setCodePreviewSettings({
        ...codePreviewSettings,
        wordEmphasis: mode,
        syntaxHighlighting: true,
      });
      results.push(
        runBench(benchCase.name, "render/highlight", mode, () => {
          sink += renderSyntaxHighlightedDiff(
            benchCase.diff,
            benchCase.lang,
            benchTheme(),
            benchCase.limit,
          ).length;
        }),
      );
    }

    for (const mode of Arr.filter(MODES, (candidateMode) => candidateMode !== "off")) {
      setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: mode });
      results.push(
        runBench(benchCase.name, "word-ranges", mode, () => {
          for (const pair of benchCase.rangePairs) {
            const ranges = changedRangesWithConfidence(pair.before, pair.after, mode);
            sink += ranges.removed.length + ranges.added.length;
          }
        }),
      );
    }
  }

  printSummary(results, cases);
  printLargeDiffEstimates(results, cases, largeScenarios);
  if (LARGE_ACTUAL) printActualLargeDiffTimings(largeScenarios);
  if (VERBOSE) printResults(results);
  else benchLog("Set BENCH_VERBOSE=1 to print the full raw benchmark table.");
  if (!LARGE_ACTUAL)
    benchLog("Set BENCH_LARGE_ACTUAL=1 to run one-shot actual large diff renders.");
  if (sink === Number.MIN_SAFE_INTEGER) benchLog("sink", sink);
} finally {
  setCodePreviewSettings(previousSettings);
  await stopShiki();
}

function runBench(caseName: string, layer: BenchLayer, mode: string, fn: () => void): BenchResult {
  const result = runSharedBench(caseName, layer, mode, fn);
  return { ...result, layer, name: `${caseName}: ${layer}` };
}

function printSummary(results: BenchResult[], benchCases: BenchCase[]): void {
  const rows = Arr.map(benchCases, (benchCase) => {
    const off = findResult(results, benchCase.name, "render/plain", "off");
    const smartRender = findResult(results, benchCase.name, "render/plain", "smart");
    const allRender = findResult(results, benchCase.name, "render/plain", "all");
    const smartRanges = findResult(results, benchCase.name, "word-ranges", "smart");
    const smartOverhead = smartRender && off ? Math.max(0, smartRender.meanMs - off.meanMs) : 0;
    const allOverhead = allRender && off ? Math.max(0, allRender.meanMs - off.meanMs) : 0;
    const smartRangeP95 = smartRanges?.p95Ms ?? 0;
    const signalMs = Math.max(smartOverhead, smartRangeP95);
    return {
      case: benchCase.name,
      pairs: benchCase.rangePairs.length,
      "chars/pair": maxPairChars(benchCase.rangePairs),
      "smart render +ms": formatMs(smartOverhead),
      "all render +ms": formatMs(allOverhead),
      "smart ranges ms": formatMs(smartRanges?.meanMs ?? 0),
      "smart ranges p95": formatMs(smartRangeP95),
      verdict: verdict(signalMs),
    };
  });

  benchLog("Word emphasis risk summary");
  benchTable(rows);
  benchLog(
    "Verdict bands use render mean overhead and word-range p95 cost: fine < 1ms, watch 1-8ms, problem > 8ms. The render columns show overhead versus wordEmphasis=off.",
  );
  benchLog("");
}

function printLargeDiffEstimates(
  results: BenchResult[],
  benchCases: BenchCase[],
  scenarios: LargeScenario[],
): void {
  const rows = Arr.map(scenarios, (scenario) => {
    const sourceCase = Option.getOrUndefined(
      Arr.findFirst(benchCases, (benchCase) => benchCase.name === scenario.baseCase),
    );
    const smartRanges = findResult(results, scenario.baseCase, "word-ranges", "smart");
    const msPerPair =
      smartRanges && sourceCase
        ? smartRanges.meanMs / Math.max(1, sourceCase.rangePairs.length)
        : 0;
    const estimates = Rec.fromEntries(
      Arr.map(scenario.pairCounts, (pairCount) => [
        `${pairCount} pairs`,
        formatDuration(msPerPair * pairCount),
      ]),
    );
    return {
      scenario: scenario.name,
      "chars/pair": sourceCase ? maxPairChars(sourceCase.rangePairs) : "?",
      "measured ms/pair": formatMs(msPerPair),
      ...estimates,
    };
  });

  benchLog("Large diff word-emphasis estimates");
  benchTable(rows);
  benchLog(
    "These estimates multiply the measured smart word-ranges cost per changed pair. They isolate word-emphasis analysis, not syntax highlighting or terminal wrapping.",
  );
  benchLog("");
}

function printActualLargeDiffTimings(scenarios: LargeScenario[]): void {
  const rows: Array<Record<string, string | number>> = [];
  for (const scenario of scenarios) {
    for (const pairCount of scenario.pairCounts) {
      const benchCase = largeCase(
        `${scenario.name} (${pairCount} pairs)`,
        pairCount,
        scenario.makePair,
      );
      setCodePreviewSettings({
        ...codePreviewSettings,
        wordEmphasis: "off",
        syntaxHighlighting: false,
      });
      const off = timeOnce(() => {
        sink += renderSyntaxHighlightedDiff(
          benchCase.diff,
          undefined,
          benchTheme(),
          benchCase.limit,
        ).length;
      });
      setCodePreviewSettings({
        ...codePreviewSettings,
        wordEmphasis: "smart",
        syntaxHighlighting: false,
      });
      const smart = timeOnce(() => {
        sink += renderSyntaxHighlightedDiff(
          benchCase.diff,
          undefined,
          benchTheme(),
          benchCase.limit,
        ).length;
      });
      rows.push({
        scenario: scenario.name,
        pairs: pairCount,
        "off render": formatDuration(off),
        "smart render": formatDuration(smart),
        "smart overhead": formatDuration(Math.max(0, smart - off)),
      });
    }
  }

  benchLog("Actual large diff one-shot timings");
  benchTable(rows);
  benchLog("");
}

function findResult(
  results: BenchResult[],
  caseName: string,
  layer: BenchResult["layer"],
  mode: string,
): BenchResult | undefined {
  return Option.getOrUndefined(
    Arr.findFirst(
      results,
      (result) => result.caseName === caseName && result.layer === layer && result.mode === mode,
    ),
  );
}

function maxPairChars(pairs: Array<{ before: string; after: string }>): number {
  return Arr.reduce(pairs, 0, (max, pair) => Math.max(max, pair.before.length, pair.after.length));
}

function verdict(ms: number): string {
  if (ms > 8) return "problem";
  if (ms >= 1) return "watch";
  return "fine";
}

function printResults(results: BenchResult[]): void {
  const rows = Arr.map(results, (result) => ({
    benchmark: result.name,
    mode: result.mode,
    iterations: result.iterations,
    "mean ms/op": result.meanMs.toFixed(4),
    "median ms/op": result.medianMs.toFixed(4),
    "p95 ms/op": result.p95Ms.toFixed(4),
    "ops/sec": result.opsPerSec.toFixed(0),
  }));
  benchTable(rows);
}

function makeCases(): BenchCase[] {
  const mediumShared = Arr.join(numberedLines("token", 180), " ");
  const longShared = Arr.join(numberedLines("shared", 600), " ");
  const unrelatedPair = unrelatedTokenPair(0, 420);
  const beforeMulti = Array.from(
    { length: 12 },
    (_, index) =>
      `- ${index + 1} const value${index} = source.${index % 2 ? "oldName" : "oldValue"};`,
  );
  const afterMulti = Array.from(
    { length: 12 },
    (_, index) =>
      `+ ${index + 1} const value${index} = target.${index % 2 ? "newName" : "newValue"};`,
  );

  return [
    pairCase(
      "small rename",
      "typescript",
      "const oldValue = line.trim();",
      "const newValue = safeLine.trim();",
    ),
    pairCase(
      "wrapper syntax",
      "typescript",
      "  .map((item) => item.title)",
      "  (item) => item.title",
    ),
    pairCase(
      "long appended markdown",
      "markdown",
      "You can also put code-preview defaults in `.pi/settings.json` globally or per project:",
      "You can also put code-preview defaults in `.pi/settings.json` globally or per project. Project settings override global settings, and the package settings file overrides both:",
    ),
    pairCase(
      "medium shared tokens",
      "typescript",
      `${mediumShared} oldValue ${mediumShared}`,
      `${mediumShared} newValue ${mediumShared}`,
    ),
    pairCase("unrelated token-heavy", "typescript", unrelatedPair.before, unrelatedPair.after),
    {
      name: "multi-line replacements",
      lang: "typescript",
      diff: Arr.join([...beforeMulti, ...afterMulti], "\n"),
      before: Arr.join(
        Arr.map(beforeMulti, (line) => Fn.pipe(line, Str.replace(/^-\s+\d+\s/, ""))),
        "\n",
      ),
      after: Arr.join(
        Arr.map(afterMulti, (line) => Fn.pipe(line, Str.replace(/^\+\s+\d+\s/, ""))),
        "\n",
      ),
      rangePairs: Arr.map(beforeMulti, (before, index) => ({
        before: Fn.pipe(before, Str.replace(/^-\s+\d+\s/, "")),
        after: Fn.pipe(afterMulti[index] ?? "", Str.replace(/^\+\s+\d+\s/, "")),
      })),
      limit: beforeMulti.length + afterMulti.length,
    },
    pairCase(
      "very long shared tokens",
      "typescript",
      `${longShared} oldValue ${longShared}`,
      `${longShared} newValue ${longShared}`,
    ),
  ];
}

function makeLargeScenarios(): LargeScenario[] {
  return [
    {
      name: "unrelated token-heavy",
      baseCase: "unrelated token-heavy",
      pairCounts: [10, 50, 100, 500],
      makePair: (index) => unrelatedTokenPair(index, 420),
    },
    {
      name: "code-like replacements",
      baseCase: "multi-line replacements",
      pairCounts: [100, 500, 1000],
      makePair: codeLikePair,
    },
    {
      name: "very long shared tokens",
      baseCase: "very long shared tokens",
      pairCounts: [10, 50, 100],
      makePair: veryLongSharedPair,
    },
  ];
}

function pairCase(name: string, lang: string, before: string, after: string): BenchCase {
  return {
    name,
    lang,
    diff: `- 1 ${before}\n+ 1 ${after}`,
    before,
    after,
    rangePairs: [{ before, after }],
    limit: 2,
  };
}

function largeCase(
  name: string,
  count: number,
  makePair: (index: number) => { before: string; after: string },
): BenchCase {
  const pairs = Array.from({ length: count }, (_, index) => makePair(index));
  return {
    name,
    lang: "typescript",
    diff: Arr.join(
      [
        ...Arr.map(pairs, (pair, index) => `- ${index + 1} ${pair.before}`),
        ...Arr.map(pairs, (pair, index) => `+ ${index + 1} ${pair.after}`),
      ],
      "\n",
    ),
    before: Arr.join(
      Arr.map(pairs, (pair) => pair.before),
      "\n",
    ),
    after: Arr.join(
      Arr.map(pairs, (pair) => pair.after),
      "\n",
    ),
    rangePairs: pairs,
    limit: pairs.length * 2,
  };
}

function unrelatedTokenPair(index: number, tokenCount: number) {
  return {
    before: Arr.join(numberedLines(`before${index}_`, tokenCount), " "),
    after: Arr.join(numberedLines(`after${index}_`, tokenCount), " "),
  };
}

function codeLikePair(index: number) {
  return {
    before: `const value${index} = source.${index % 2 ? "oldName" : "oldValue"} ?? fallback${index};`,
    after: `const value${index} = target.${index % 2 ? "newName" : "newValue"} ?? fallback${index};`,
  };
}

function veryLongSharedPair(index: number) {
  const shared = Arr.join(numberedLines(`shared${index}_`, 600), " ");
  return {
    before: `${shared} oldValue ${shared}`,
    after: `${shared} newValue ${shared}`,
  };
}
