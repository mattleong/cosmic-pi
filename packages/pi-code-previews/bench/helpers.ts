import { performance } from "node:perf_hooks";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

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

export const WARMUP_MS = readPositiveNumber("BENCH_WARMUP_MS", 20);
export const SAMPLE_MS = readPositiveNumber("BENCH_SAMPLE_MS", 80);
export const SAMPLES = Math.floor(readPositiveNumber("BENCH_SAMPLES", 5));
export const VERBOSE = isEnabled("BENCH_VERBOSE");

export function printBenchHeader(name: string): void {
  console.log(`pi-code-previews ${name} benchmark`);
  console.log(`node=${process.version} platform=${process.platform}/${process.arch}`);
  console.log(`timestamp=${new Date().toISOString()}`);
  console.log(`warmupMs=${WARMUP_MS} sampleMs=${SAMPLE_MS} samples=${SAMPLES}`);
  console.log("");
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
  const sampleMeans = samples.map((sample) => sample.ms / sample.iterations).sort((a, b) => a - b);
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

export function printResults(results: BenchResult[], verbose = VERBOSE): void {
  if (!verbose) {
    console.log("Set BENCH_VERBOSE=1 to print the full raw benchmark table.");
    return;
  }
  console.table(
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
  console.table(
    results.map((result) => ({
      case: result.caseName,
      layer: result.layer,
      mode: result.mode,
      "mean ms/op": formatMs(result.meanMs),
      "p95 ms/op": formatMs(result.p95Ms),
      "ops/sec": result.opsPerSec.toFixed(0),
    })),
  );
  console.log("");
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
  return /^(?:1|true|yes|on)$/i.test(process.env[name] ?? "");
}

export function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function numberedLines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

export function benchTheme(): Theme {
  const fgAnsi: Record<string, string> = {
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
  };
  const bgAnsi: Record<string, string> = {
    toolErrorBg: "\x1b[48;2;45;18;24m",
    toolSuccessBg: "\x1b[48;2;18;40;26m",
  };
  return {
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    fg: (key: string, text: string) => `${fgAnsi[key] ?? ""}${text}\x1b[39m`,
    getFgAnsi: (key: string) => fgAnsi[key] ?? "",
    getBgAnsi: (key: string) => bgAnsi[key] ?? "",
  } as Theme;
}

function runFor(ms: number, fn: () => void): { iterations: number; ms: number } {
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
