import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AUTH_FILE, getXaiCredentials } from "./auth.ts";
import { isRecord } from "./utils.ts";

export { AUTH_FILE };

export const BILLING_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const MONTHLY_BILLING_URL = `${BILLING_BASE_URL}/billing`;
export const WEEKLY_BILLING_URL = `${BILLING_BASE_URL}/billing?format=credits`;

export type UsageSnapshot = {
  capturedAt: number;
  weeklyUsedPercent: number | null;
  weeklyLeftPercent: number | null;
  weeklyResetInSeconds: number | null;
  monthlyUsed: number | null;
  monthlyLimit: number | null;
  monthlyUsedPercent: number | null;
  monthlyLeftPercent: number | null;
  monthlyResetInSeconds: number | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  isLimited: boolean;
};

type ResetClockFormatters = {
  time: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
  date: Intl.DateTimeFormat;
};
const RESET_CLOCK_FORMATTER_CACHE_LIMIT = 4;
const resetClockFormatters = new Map<string, ResetClockFormatters>();

function currentTimeZoneKey(date: Date): string {
  const zoneLabel = /\(([^)]+)\)$/.exec(date.toString())?.[1] ?? "";
  return `${process.env.TZ ?? ""}:${date.getTimezoneOffset()}:${zoneLabel}`;
}

function getResetClockFormatters(now: Date, reset: Date): ResetClockFormatters {
  const timeZoneKey = `${currentTimeZoneKey(now)}:${reset.getTimezoneOffset()}`;
  let formatters = resetClockFormatters.get(timeZoneKey);
  if (!formatters) {
    formatters = {
      time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
      weekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }),
      date: new Intl.DateTimeFormat(undefined, { month: "numeric", day: "numeric" }),
    };
    resetClockFormatters.set(timeZoneKey, formatters);
    while (resetClockFormatters.size > RESET_CLOCK_FORMATTER_CACHE_LIMIT) {
      const oldestKey = resetClockFormatters.keys().next().value;
      if (oldestKey === undefined) break;
      resetClockFormatters.delete(oldestKey);
    }
  }
  return formatters;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usedToLeftPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampPercent(100 - value);
}

function nestedNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!isRecord(value)) return null;
  const nested = value.val;
  return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
}

function parseIsoToSecondsFromNow(value: unknown, now: number): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const resetAt = Date.parse(value);
  if (!Number.isFinite(resetAt)) return null;
  return Math.max(0, (resetAt - now) / 1000);
}

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

function formatResetClock(
  seconds: number | null,
  options?: { includeDate?: boolean },
  now = Date.now(),
): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const resetDate = new Date(now + seconds * 1000);
  const currentDate = new Date(now);
  const formatters = getResetClockFormatters(currentDate, resetDate);
  const time = formatters.time.format(resetDate);
  if (!options?.includeDate && resetDate.toDateString() === currentDate.toDateString()) return time;
  const weekday = formatters.weekday.format(resetDate);
  if (!options?.includeDate) return `${weekday} ${time}`;
  const date = formatters.date.format(resetDate);
  return `${weekday} ${date} ${time}`;
}

function formatCompactReset(
  label: string,
  seconds: number | null,
  options?: { includeDate?: boolean },
  now = Date.now(),
): string | null {
  const countdown = formatResetCountdown(seconds);
  const clock = formatResetClock(seconds, options, now);
  return countdown && clock ? `${label} ↺ ${countdown} - ${clock}` : null;
}

export function parseMonthlyBilling(
  payload: unknown,
  now = Date.now(),
): Pick<
  UsageSnapshot,
  | "monthlyUsed"
  | "monthlyLimit"
  | "monthlyUsedPercent"
  | "monthlyLeftPercent"
  | "monthlyResetInSeconds"
  | "onDemandCap"
> {
  const root = isRecord(payload) ? payload : null;
  const config = isRecord(root?.config) ? root.config : null;
  const monthlyUsed = nestedNumber(config?.used);
  const monthlyLimit = nestedNumber(config?.monthlyLimit);
  const onDemandCap = nestedNumber(config?.onDemandCap);
  let monthlyUsedPercent: number | null = null;
  if (typeof monthlyUsed === "number" && typeof monthlyLimit === "number" && monthlyLimit > 0) {
    monthlyUsedPercent = clampPercent((monthlyUsed / monthlyLimit) * 100);
  }
  return {
    monthlyUsed,
    monthlyLimit,
    monthlyUsedPercent,
    monthlyLeftPercent: usedToLeftPercent(monthlyUsedPercent),
    monthlyResetInSeconds: parseIsoToSecondsFromNow(config?.billingPeriodEnd, now),
    onDemandCap,
  };
}

export function parseWeeklyBilling(
  payload: unknown,
  now = Date.now(),
): Pick<
  UsageSnapshot,
  "weeklyUsedPercent" | "weeklyLeftPercent" | "weeklyResetInSeconds" | "onDemandUsed"
> {
  const root = isRecord(payload) ? payload : null;
  const config = isRecord(root?.config) ? root.config : null;
  const rawPercent = config?.creditUsagePercent;
  // Fresh weekly periods may omit the percent; treat as 0% used.
  const weeklyUsedPercent =
    typeof rawPercent === "number" && Number.isFinite(rawPercent)
      ? clampPercent(rawPercent)
      : config
        ? 0
        : null;
  const period = isRecord(config?.currentPeriod) ? config.currentPeriod : null;
  const resetIso =
    (typeof config?.billingPeriodEnd === "string" && config.billingPeriodEnd) ||
    (typeof period?.end === "string" && period.end) ||
    null;
  return {
    weeklyUsedPercent,
    weeklyLeftPercent: usedToLeftPercent(weeklyUsedPercent),
    weeklyResetInSeconds: parseIsoToSecondsFromNow(resetIso, now),
    onDemandUsed: nestedNumber(config?.onDemandUsed),
  };
}

export function parseUsageSnapshot(
  monthlyPayload: unknown,
  weeklyPayload: unknown | null | undefined,
  now = Date.now(),
): UsageSnapshot {
  const monthly = parseMonthlyBilling(monthlyPayload, now);
  const weekly =
    weeklyPayload == null
      ? {
          weeklyUsedPercent: null,
          weeklyLeftPercent: null,
          weeklyResetInSeconds: null,
          onDemandUsed: null,
        }
      : parseWeeklyBilling(weeklyPayload, now);
  const isLimited =
    (weekly.weeklyUsedPercent !== null && weekly.weeklyUsedPercent >= 100) ||
    (monthly.monthlyUsed !== null &&
      monthly.monthlyLimit !== null &&
      monthly.monthlyUsed >= monthly.monthlyLimit);
  return {
    capturedAt: now,
    ...weekly,
    ...monthly,
    onDemandUsed: weekly.onDemandUsed ?? null,
    isLimited,
  };
}

export function formatPercent(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
}

function remainingResetSeconds(
  seconds: number | null,
  capturedAt: number,
  now: number,
): number | null {
  return seconds === null ? null : seconds - (now - capturedAt) / 1000;
}

export function formatUsageSnapshot(
  snapshot: UsageSnapshot,
  options: { showResetTimes: boolean },
  now = Date.now(),
): string {
  const hasWeekly = snapshot.weeklyLeftPercent !== null || snapshot.weeklyResetInSeconds !== null;
  const hasMonthly =
    snapshot.monthlyLeftPercent !== null || snapshot.monthlyResetInSeconds !== null;
  // Match OpenAI footer shape so cosmic-ui can render progress bars:
  // "Usage: 7d: 82% | mo: 83% | 7d ↺ … | mo ↺ …"
  const windows = [
    hasWeekly ? `7d: ${formatPercent(snapshot.weeklyLeftPercent)}` : null,
    hasMonthly ? `mo: ${formatPercent(snapshot.monthlyLeftPercent)}` : null,
  ].filter((value): value is string => value !== null);
  const resets = options.showResetTimes
    ? [
        hasWeekly
          ? formatCompactReset(
              "7d",
              remainingResetSeconds(snapshot.weeklyResetInSeconds, snapshot.capturedAt, now),
              undefined,
              now,
            )
          : null,
        hasMonthly
          ? formatCompactReset(
              "mo",
              remainingResetSeconds(snapshot.monthlyResetInSeconds, snapshot.capturedAt, now),
              { includeDate: true },
              now,
            )
          : null,
      ].filter((value): value is string => value !== null)
    : [];
  return `Usage: ${windows.length ? windows.join(" | ") : "--"}${resets.length ? ` | ${resets.join(" | ")}` : ""}`;
}

export function formatUsageDetails(snapshot: UsageSnapshot, now = Date.now()): string {
  const weeklyUsed =
    snapshot.weeklyUsedPercent === null ? "--" : `${Math.round(snapshot.weeklyUsedPercent)}% used`;
  const weeklyLeft = formatPercent(snapshot.weeklyLeftPercent);
  const monthly =
    snapshot.monthlyUsed !== null && snapshot.monthlyLimit !== null
      ? `${snapshot.monthlyUsed.toLocaleString()} / ${snapshot.monthlyLimit.toLocaleString()}`
      : "--";
  const monthlyLeft = formatPercent(snapshot.monthlyLeftPercent);
  const weeklyReset = formatCompactReset(
    "7d",
    remainingResetSeconds(snapshot.weeklyResetInSeconds, snapshot.capturedAt, now),
    undefined,
    now,
  );
  const monthlyReset = formatCompactReset(
    "mo",
    remainingResetSeconds(snapshot.monthlyResetInSeconds, snapshot.capturedAt, now),
    { includeDate: true },
    now,
  );
  const onDemand =
    snapshot.onDemandCap && snapshot.onDemandCap > 0
      ? `$${(snapshot.onDemandUsed ?? 0) / 100} / $${snapshot.onDemandCap / 100}`
      : "disabled";
  return [
    "xAI subscription usage",
    `  Weekly:  ${weeklyUsed} (${weeklyLeft} left)${weeklyReset ? `  · ${weeklyReset}` : ""}`,
    `  Monthly: ${monthly} (${monthlyLeft} left)${monthlyReset ? `  · ${monthlyReset}` : ""}`,
    `  On-demand: ${onDemand}`,
    `  Source: ${MONTHLY_BILLING_URL}`,
  ].join("\n");
}

async function fetchJson(
  url: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<{ ok: true; payload: unknown } | { ok: false; status: number }> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    signal,
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, payload: await response.json() };
}

export async function requestXaiUsage(
  ctx?: Pick<ExtensionContext, "modelRegistry">,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<UsageSnapshot | undefined> {
  const credentials = await getXaiCredentials(ctx, signal, now);
  if (!credentials) return undefined;

  const [monthly, weekly] = await Promise.all([
    fetchJson(MONTHLY_BILLING_URL, credentials.accessToken, signal),
    fetchJson(WEEKLY_BILLING_URL, credentials.accessToken, signal).catch(() => ({
      ok: false as const,
      status: 0,
    })),
  ]);
  if (!monthly.ok) throw new Error(`xAI monthly billing request failed (HTTP ${monthly.status})`);
  const weeklyPayload = weekly.ok ? weekly.payload : null;
  return parseUsageSnapshot(monthly.payload, weeklyPayload, now);
}
