import * as DateTime from "effect/DateTime";

export function formatResetCountdown(seconds: number | null): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
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

export function formatResetClock(
  seconds: number | null,
  options: { readonly includeDate?: boolean } | undefined,
  now: number,
): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const reset = DateTime.makeUnsafe(now + seconds * 1000);
  const current = DateTime.makeUnsafe(now);
  const time = DateTime.formatLocal(reset, { hour: "numeric", minute: "2-digit" });
  const resetDay = DateTime.formatLocal(reset, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const currentDay = DateTime.formatLocal(current, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  if (!options?.includeDate && resetDay === currentDay) return time;
  const weekday = DateTime.formatLocal(reset, { weekday: "short" });
  if (!options?.includeDate) return `${weekday} ${time}`;
  return `${weekday} ${DateTime.formatLocal(reset, { month: "numeric", day: "numeric" })} ${time}`;
}

export function formatCompactReset(
  label: string,
  seconds: number | null,
  options: { readonly includeDate?: boolean } | undefined,
  now: number,
): string | null {
  const countdown = formatResetCountdown(seconds);
  const clock = formatResetClock(seconds, options, now);
  return countdown && clock ? `${label} ↺ ${countdown} - ${clock}` : null;
}

/** Clamp a finite percent into the inclusive 0–100 range. */
export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Format a remaining-percent value for subscription status lines. */
export function formatPercent(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
}

/** Convert a snapshot-relative reset countdown into seconds remaining from `now`. */
export function remainingResetSeconds(
  seconds: number | null,
  capturedAt: number,
  now: number,
): number | null {
  return seconds === null ? null : seconds - (now - capturedAt) / 1000;
}

export type UsageWindowLine = {
  readonly label: string;
  readonly leftPercent: number | null;
  readonly resetInSeconds: number | null;
  readonly includeDate?: boolean;
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
          formatCompactReset(
            window.label,
            remainingResetSeconds(window.resetInSeconds, capturedAt, now),
            window.includeDate ? { includeDate: true } : undefined,
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
