/**
 * Display formatting shared by every extension, so durations, ages, counts, sizes, costs, and
 * clipped text read the same in tool rows, managers, footers, and notifications.
 */
import { safeTextPrefix } from "./text.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const finite = (value: number) => (Number.isFinite(value) ? Math.max(0, value) : 0);

/** Two largest units of a whole-second span, dropping a zero second unit: "2m 5s", "2m", "1h 3m". */
const unitPair = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / SECOND);
  const pair = (large: number, largeUnit: string, small: number, smallUnit: string) =>
    small > 0 ? `${large}${largeUnit} ${small}${smallUnit}` : `${large}${largeUnit}`;
  if (seconds >= 86_400)
    return pair(Math.floor(seconds / 86_400), "d", Math.floor((seconds % 86_400) / 3_600), "h");
  if (seconds >= 3_600)
    return pair(Math.floor(seconds / 3_600), "h", Math.floor((seconds % 3_600) / 60), "m");
  return pair(Math.floor(seconds / 60), "m", seconds % 60, "s");
};

/** How long something took: "450ms", "1.5s", "12s", "2m 5s", "1h 3m", "2d 4h". */
export const formatDuration = (milliseconds: number): string => {
  const value = Math.round(finite(milliseconds));
  if (value < SECOND) return `${value}ms`;
  if (value < MINUTE) {
    const seconds = Number((value / SECOND).toFixed(1));
    if (seconds < 60) return `${seconds}s`;
  }
  return unitPair(value);
};

/** A live clock in whole seconds: "0s", "12s", "2m 5s", "1h 3m". */
export const formatElapsed = (milliseconds: number): string => {
  const value = Math.floor(finite(milliseconds) / SECOND) * SECOND;
  return value < MINUTE ? `${value / SECOND}s` : unitPair(value);
};

/** How long ago something happened: "just now", "5s ago", "2m ago", "1h ago", "3d ago". */
export const formatRelativeAge = (milliseconds: number): string => {
  const value = finite(milliseconds);
  if (value < SECOND) return "just now";
  if (value < MINUTE) return `${Math.floor(value / SECOND)}s ago`;
  if (value < HOUR) return `${Math.floor(value / MINUTE)}m ago`;
  if (value < DAY) return `${Math.floor(value / HOUR)}h ago`;
  return `${Math.floor(value / DAY)}d ago`;
};

/** A count with its noun: "1 file", "2 files", "1 query" / "3 queries" with an explicit plural. */
export const countLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

/** A byte size in 1024-based units: "1 byte", "512 bytes", "1.5 KB", "2.0 MB", "1.2 GB". */
export const formatBytes = (bytes: number): string => {
  const value = Math.round(finite(bytes));
  if (value < 1024) return countLabel(value, "byte");
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
};

/** A dollar cost: "$0", "$<0.0001", "$0.0012", "$0.12", "$12.50". */
export const formatCost = (cost: number): string => {
  const value = finite(cost);
  if (value === 0) return "$0";
  if (value < 0.0001) return "$<0.0001";
  if (value < 0.01) return `$${value.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "")}`;
  return `$${value.toFixed(2)}`;
};

/**
 * At most `limit` UTF-16 units, marker included, never splitting a surrogate pair. Clipped text
 * loses trailing spaces before the marker: "a long sentence th…".
 */
export const clipText = (text: string, limit: number): string => {
  const budget = Math.max(0, Math.floor(limit));
  if (text.length <= budget) return text;
  if (budget <= 1) return safeTextPrefix("…", budget);
  return `${safeTextPrefix(text, budget - 1).trimEnd()}…`;
};
