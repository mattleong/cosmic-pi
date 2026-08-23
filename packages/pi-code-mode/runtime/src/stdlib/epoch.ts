import * as DateTime from "effect/DateTime";

/**
 * Guest-facing epoch helpers.
 *
 * Guest programs keep real JavaScript `Date` semantics (wall-clock `Date.now()`, spec
 * `TimeClip` normalization, local-time component construction), while host code never
 * touches the `Date` global directly: instants are represented through Effect `DateTime`
 * and converted to a host `Date` instance only for component reads and ISO formatting.
 */

/** Spec TimeClip bound: the largest epoch offset a JS Date can represent. */
const MAX_EPOCH_MILLIS = 8_640_000_000_000_000;

/** Wall-clock now for guest `Date.now()` / `new Date()`. Deliberately not the Effect Clock: guest time is real JS time. */
export const epochNow = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());

/** Spec `TimeClip`: how `new Date(number)` normalizes its argument. */
export const clipEpochMillis = (value: number): number => {
  if (!Number.isFinite(value)) return Number.NaN;
  const truncated = Math.trunc(value) + 0;
  return Math.abs(truncated) > MAX_EPOCH_MILLIS ? Number.NaN : truncated;
};

/** A host Date over a finite guest epoch, for component reads and ISO formatting. */
export const hostDate = (time: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(time));

/** `Date.prototype.toISOString` over a finite guest epoch. */
export const isoString = (time: number): string => hostDate(time).toISOString();

/**
 * JS `new Date(year, month, day?, ...)`: the local-time component form. Native local
 * setters preserve the host engine's exact overflow and daylight-saving disambiguation.
 */
export const epochFromLocalParts = (parts: ReadonlyArray<number>): number => {
  const [year = Number.NaN, month = 0, day = 1, hours = 0, minutes = 0, seconds = 0, ms = 0] =
    parts;
  const hosted = hostDate(0);
  const normalizedYear = Math.trunc(year);
  const adjustedYear = normalizedYear >= 0 && normalizedYear <= 99 ? normalizedYear + 1900 : year;
  hosted.setFullYear(adjustedYear, month, day);
  hosted.setHours(hours, minutes, seconds, ms);
  return hosted.getTime();
};
