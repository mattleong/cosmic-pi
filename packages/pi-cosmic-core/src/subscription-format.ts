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
