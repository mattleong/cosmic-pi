// Benchmark reporting and high-resolution timing are explicit non-application boundaries.
import { performance } from "node:perf_hooks";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Synchronous Effect Console bridge for benchmark reporting. */
export function benchLog(...args: ReadonlyArray<unknown>): void {
  Effect.runSync(Console.log(...args));
}

/** One printable benchmark table row: report labels mapped to formatted cells. */
type BenchTableRow = Record<string, string | number | boolean | undefined>;

/** Synchronous Effect Console bridge for tabular benchmark reporting. */
export function benchTable(rows: ReadonlyArray<BenchTableRow>): void {
  Effect.runSync(Console.table(rows));
}

function readBenchEnvironment(name: string): string | undefined {
  return Option.getOrUndefined(Effect.runSync(Config.option(Config.String(name))));
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
  const fgAnsi = new Map<string, string>(
    Object.entries({
      accent: "\x1b[38;2;120;180;255m",
      error: "\x1b[38;2;255;110;120m",
      muted: "\x1b[38;2;140;145;155m",
      success: "\x1b[38;2;95;210;130m",
      toolDiffAdded: "\x1b[38;2;95;210;130m",
      toolDiffContext: "\x1b[38;2;200;205;215m",
      toolDiffRemoved: "\x1b[38;2;255;110;120m",
      toolOutput: "\x1b[38;2;200;205;215m",
      toolTitle: "\x1b[38;2;150;190;255m",
      warning: "\x1b[38;2;255;205;95m",
    }),
  );
  const bgAnsi = new Map<string, string>(
    Object.entries({
      toolErrorBg: "\x1b[48;2;45;18;24m",
      toolSuccessBg: "\x1b[48;2;18;40;26m",
    }),
  );
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  return {
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    fg: (key: string, text: string) => `${fgAnsi.get(key) ?? ""}${text}\x1b[39m`,
    getFgAnsi: (key: string) => fgAnsi.get(key) ?? "",
    getBgAnsi: (key: string) => bgAnsi.get(key) ?? "",
  } as Theme;
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
