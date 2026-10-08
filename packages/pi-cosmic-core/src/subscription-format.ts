import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

function formatResetCountdown(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${secs}s`;
}

/** The reset instant `seconds` after `now` with its countdown; undefined unless both are finite. */
function resetAt(seconds: number | null, now: number) {
  if (!Predicate.isNumber(seconds) || !Number.isFinite(seconds) || !Number.isFinite(now))
    return undefined;
  const reset = DateTime.make(now + seconds * 1000);
  return Option.isSome(reset)
    ? { reset: reset.value, countdown: formatResetCountdown(seconds) }
    : undefined;
}

const LOCAL_DAY = { year: "numeric", month: "2-digit", day: "2-digit" } as const;

export function formatCompactReset(
  label: string,
  seconds: number | null,
  options: { readonly includeDate?: boolean } | undefined,
  now: number,
): string | null {
  const at = resetAt(seconds, now);
  const current = DateTime.make(now);
  if (at === undefined || Option.isNone(current)) return null;
  const time = DateTime.formatLocal(at.reset, { hour: "numeric", minute: "2-digit" });
  const weekday = DateTime.formatLocal(at.reset, { weekday: "short" });
  let clock = `${weekday} ${time}`;
  if (options?.includeDate)
    clock = `${weekday} ${DateTime.formatLocal(at.reset, { month: "numeric", day: "numeric" })} ${time}`;
  else if (
    DateTime.formatLocal(at.reset, LOCAL_DAY) === DateTime.formatLocal(current.value, LOCAL_DAY)
  )
    clock = time;
  return `${label} ↺ ${at.countdown} - ${clock}`;
}

/** Formats a reset with a compact local date/time while retaining its countdown. */
function formatShortReset(label: string, seconds: number | null, now: number): string | null {
  const at = resetAt(seconds, now);
  if (at === undefined) return null;
  const date = DateTime.formatLocal(at.reset, {
    locale: "en-US",
    month: "numeric",
    day: "numeric",
  });
  const time = DateTime.formatLocal(at.reset, {
    locale: "en-US",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .replace(/\s+/gu, "")
    .replace(/AM$/u, "a")
    .replace(/PM$/u, "p");
  return `${label} ↺ ${at.countdown} - ${date} • ${time}`;
}

/** Clamp a finite percent into the inclusive 0–100 range. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Convert a finite used-percent value into the clamped remaining percent. */
export function usedToLeftPercent(value: number | null | undefined): number | null {
  return Predicate.isNumber(value) && Number.isFinite(value) ? clampPercent(100 - value) : null;
}

/** A local date and time of day, such as "Sep 27, 2026, 10:07 AM". */
export function formatTimestamp(value: number): string {
  return DateTime.formatLocal(DateTime.makeUnsafe(value), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Format an epoch-millis timestamp for diagnostic output, or "never" when absent. */
export function formatTimestampOrNever(value: number | undefined): string {
  return value === undefined ? "never" : formatTimestamp(value);
}

/** Format a remaining-percent value for subscription status lines. */
export function formatPercent(value: number | null): string {
  return Predicate.isNumber(value) && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
}

/** Convert a snapshot-relative reset countdown into seconds remaining from `now`. */
export function remainingResetSeconds(
  seconds: number | null,
  capturedAt: number,
  now: number,
): number | null {
  if (
    seconds === null ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(now)
  )
    return null;
  const remaining = seconds - (now - capturedAt) / 1000;
  return Number.isFinite(remaining) ? remaining : null;
}

type UsageWindowLine = {
  readonly label: string;
  readonly leftPercent: number | null;
  readonly resetInSeconds: number | null;
};

/**
 * Shared "Usage: 5h: 80% | 7d: 90% | 5h ↺ …" status-line assembly used by provider footers.
 * A window is shown when either its percent or reset countdown is present.
 */
export function formatWindowedUsageLine(
  windows: readonly UsageWindowLine[],
  options: { readonly showResetTimes: boolean },
  now: number,
  capturedAt: number,
): string {
  const visible = windows.filter(
    (window) => window.leftPercent !== null || window.resetInSeconds !== null,
  );
  const labels = visible.map((window) => `${window.label}: ${formatPercent(window.leftPercent)}`);
  const resets = options.showResetTimes
    ? visible
        .map((window) =>
          formatShortReset(
            window.label,
            remainingResetSeconds(window.resetInSeconds, capturedAt, now),
            now,
          ),
        )
        .filter((value): value is string => value !== null)
    : [];
  return `Usage: ${labels.length ? labels.join(" | ") : "--"}${resets.length ? ` | ${resets.join(" | ")}` : ""}`;
}

/** Compact token counts for footer metrics (1.2k, 15k, 1.5M). */
export function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}
