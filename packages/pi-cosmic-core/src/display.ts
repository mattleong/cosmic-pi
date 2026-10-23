import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { safeTextPrefix } from "./text.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const finite = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);

const pair = (large: number, largeUnit: string, small: number, smallUnit: string) =>
  small > 0 ? `${large}${largeUnit} ${small}${smallUnit}` : `${large}${largeUnit}`;

const unitPair = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / SECOND);
  if (seconds >= 86_400)
    return pair(Math.floor(seconds / 86_400), "d", Math.floor((seconds % 86_400) / 3_600), "h");
  if (seconds >= 3_600)
    return pair(Math.floor(seconds / 3_600), "h", Math.floor((seconds % 3_600) / 60), "m");
  return pair(Math.floor(seconds / 60), "m", seconds % 60, "s");
};

export const formatDuration = (milliseconds: number): string => {
  const value = Math.round(finite(milliseconds));
  if (value < SECOND) return `${value}ms`;
  if (value < MINUTE) {
    const seconds = Number((value / SECOND).toFixed(1));
    if (seconds < 60) return `${seconds}s`;
  }
  return unitPair(value);
};

export const formatElapsed = (milliseconds: number): string => {
  const value = Math.floor(finite(milliseconds) / SECOND) * SECOND;
  return value < MINUTE ? `${value / SECOND}s` : unitPair(value);
};

export const formatRelativeAge = (milliseconds: number): string => {
  const value = finite(milliseconds);
  if (value < SECOND) return "just now";
  if (value < MINUTE) return `${Math.floor(value / SECOND)}s ago`;
  if (value < HOUR) return `${Math.floor(value / MINUTE)}m ago`;
  if (value < DAY) return `${Math.floor(value / HOUR)}h ago`;
  return `${Math.floor(value / DAY)}d ago`;
};

export const countLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

export const formatBytes = (bytes: number): string => {
  const value = Math.round(finite(bytes));
  if (value < 1024) return countLabel(value, "byte");
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
};

export const formatCost = (cost: number): string => {
  const value = finite(cost);
  if (value === 0) return "$0";
  if (value < 0.0001) return "$<0.0001";
  if (value < 0.01)
    return `$${Fn.pipe(value.toFixed(4), Str.replace(/0+$/u, ""), Str.replace(/\.$/u, ""))}`;
  return `$${value.toFixed(2)}`;
};

export const formatTokens = (count: number): string => {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
};

export const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

export const clipText = (text: string, limit: number): string => {
  const budget = Math.max(0, Math.floor(limit));
  if (text.length <= budget) return text;
  if (budget <= 1) return safeTextPrefix("…", budget);
  return `${Str.trimEnd(safeTextPrefix(text, budget - 1))}…`;
};
