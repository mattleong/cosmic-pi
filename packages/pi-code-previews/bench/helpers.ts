import { performance } from "node:perf_hooks";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

export function benchLog(...args: ReadonlyArray<unknown>): void {
  Effect.runSync(Console.log(...args));
}

type BenchTableRow = Record<string, string | number | boolean | undefined>;

export function benchTable(rows: ReadonlyArray<BenchTableRow>): void {
  Effect.runSync(Console.table(rows));
}

function readBenchEnvironment(name: string): string | undefined {
  return Option.getOrUndefined(Effect.runSync(Config.String(name).pipe(Config.option)));
}

export type BenchResult = {
  caseName: string;
  layer: string;
  mode: string;
  iterations: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  opsPerSec: number;
};

const WARMUP_MS = readPositiveNumber("BENCH_WARMUP_MS", 20);
const SAMPLE_MS = readPositiveNumber("BENCH_SAMPLE_MS", 80);
const SAMPLES = Math.floor(readPositiveNumber("BENCH_SAMPLES", 5));
export const VERBOSE = isEnabled("BENCH_VERBOSE");

export function printBenchHeader(name: string): void {
  benchLog(`pi-code-previews ${name} benchmark`);
  benchLog(`node=${process.version} platform=${process.platform}/${process.arch}`);
  benchLog(`timestamp=${DateTime.formatIso(Effect.runSync(DateTime.now))}`);
  benchLog(`warmupMs=${WARMUP_MS} sampleMs=${SAMPLE_MS} samples=${SAMPLES}`);
  benchLog("");
}

export function runBench(
  caseName: string,
  layer: string,
  mode: string,
  fn: () => void,
): BenchResult {
  runFor(WARMUP_MS, fn);
  const samples: Array<{ iterations: number; ms: number }> = [];
  for (let sample = 0; sample < SAMPLES; sample++) samples.push(runFor(SAMPLE_MS, fn));
  const iterations = samples.reduce((total, sample) => total + sample.iterations, 0);
  const totalMs = samples.reduce((total, sample) => total + sample.ms, 0);
  const sampleMeans = samples
    .map((sample) => sample.ms / sample.iterations)
    .toSorted((a, b) => a - b);
  const meanMs = totalMs / iterations;
  return {
    caseName,
    layer,
    mode,
    iterations,
    meanMs,
    medianMs: percentile(sampleMeans, 0.5),
    p95Ms: percentile(sampleMeans, 0.95),
    opsPerSec: 1000 / meanMs,
  };
}

export function timeOnce(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

export function printResults(results: BenchResult[]): void {
  if (!VERBOSE) {
    benchLog("Set BENCH_VERBOSE=1 to print the full raw benchmark table.");
    return;
  }
  benchTable(
    results.map((result) => ({
      case: result.caseName,
      layer: result.layer,
      mode: result.mode,
      iterations: result.iterations,
      "mean ms/op": formatMs(result.meanMs),
      "median ms/op": formatMs(result.medianMs),
      "p95 ms/op": formatMs(result.p95Ms),
      "ops/sec": result.opsPerSec.toFixed(0),
    })),
  );
}

export function printLayerSummary(results: BenchResult[]): void {
  benchTable(
    results.map((result) => ({
      case: result.caseName,
      layer: result.layer,
      mode: result.mode,
      "mean ms/op": formatMs(result.meanMs),
      "p95 ms/op": formatMs(result.p95Ms),
      "ops/sec": result.opsPerSec.toFixed(0),
    })),
  );
  benchLog("");
}

export function renderComponent(component: Component, width: number): string {
  return component.render(width).join("\n");
}

export function formatMs(ms: number): string {
  return ms.toFixed(ms >= 10 ? 1 : 3);
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s`;
  return `${formatMs(ms)}ms`;
}

export function isEnabled(name: string): boolean {
  return /^(?:1|true|yes|on)$/i.test(readBenchEnvironment(name) ?? "");
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(readBenchEnvironment(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function numberedLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

export function benchTheme(): Theme {
  return new Theme(
    {
      accent: "#78b4ff",
      border: "",
      borderAccent: "",
      borderMuted: "",
      success: "#5fd282",
      error: "#ff6e78",
      warning: "#ffcd5f",
      muted: "#8c919b",
      dim: "",
      text: "",
      thinkingText: "",
      userMessageText: "",
      customMessageText: "",
      customMessageLabel: "",
      toolTitle: "#96beff",
      toolOutput: "#c8cdd7",
      mdHeading: "",
      mdLink: "",
      mdLinkUrl: "",
      mdCode: "",
      mdCodeBlock: "",
      mdCodeBlockBorder: "",
      mdQuote: "",
      mdQuoteBorder: "",
      mdHr: "",
      mdListBullet: "",
      toolDiffAdded: "#5fd282",
      toolDiffRemoved: "#ff6e78",
      toolDiffContext: "#c8cdd7",
      syntaxComment: "",
      syntaxKeyword: "",
      syntaxFunction: "",
      syntaxVariable: "",
      syntaxString: "",
      syntaxNumber: "",
      syntaxType: "",
      syntaxOperator: "",
      syntaxPunctuation: "",
      thinkingOff: "",
      thinkingMinimal: "",
      thinkingLow: "",
      thinkingMedium: "",
      thinkingHigh: "",
      thinkingXhigh: "",
      bashMode: "",
    },
    {
      selectedBg: "",
      userMessageBg: "",
      customMessageBg: "",
      toolPendingBg: "",
      toolSuccessBg: "#12281a",
      toolErrorBg: "#2d1218",
    },
    "truecolor",
  );
}

function runFor(ms: number, fn: () => void) {
  const start = performance.now();
  const deadline = start + ms;
  let iterations = 0;
  do {
    fn();
    iterations++;
  } while (performance.now() < deadline);
  return { iterations, ms: performance.now() - start };
}

function percentile(sorted: number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? 0;
}
