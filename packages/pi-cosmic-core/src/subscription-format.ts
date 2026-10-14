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

function resetAt(seconds: number | null, now: number) {
  if (!Predicate.isNumber(seconds) || !Number.isFinite(seconds) || !Number.isFinite(now))
    return undefined;
  const reset = DateTime.make(now + seconds * 1000);
  return Option.isSome(reset)
    ? { reset: reset.value, countdown: formatResetCountdown(seconds) }
    : undefined;
}

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

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function usedToLeftPercent(value: number | null | undefined): number | null {
  return Predicate.isNumber(value) && Number.isFinite(value) ? clampPercent(100 - value) : null;
}

export function formatTimestamp(value: number): string {
  return DateTime.formatLocal(DateTime.makeUnsafe(value), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatTimestampOrNever(value: number | undefined): string {
  return value === undefined ? "never" : formatTimestamp(value);
}

export function formatPercent(value: number | null): string {
  return Predicate.isNumber(value) && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
}

function remainingResetSeconds(
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
    ? visible.flatMap((window) => {
        const reset = formatShortReset(
          window.label,
          remainingResetSeconds(window.resetInSeconds, capturedAt, now),
          now,
        );
        return reset === null ? [] : [reset];
      })
    : [];
  return `Usage: ${labels.length ? labels.join(" | ") : "--"}${resets.length ? ` | ${resets.join(" | ")}` : ""}`;
}

export function formatTokens(count: number): string {
  if (count < 1_000) return `${count}`;
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}
