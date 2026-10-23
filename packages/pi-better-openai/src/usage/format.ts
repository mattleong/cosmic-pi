import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { clampPercent, JsonHttpClient } from "pi-cosmic-core";
import type { CodexCredentials } from "../auth/codex-auth.ts";

export type UsageSnapshot = {
  capturedAt: number;
  fiveHourLeftPercent: number | null;
  sevenDayLeftPercent: number | null;
  fiveHourResetInSeconds: number | null;
  sevenDayResetInSeconds: number | null;
};
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const MAX_RESET_SECONDS = 366 * 86_400;
const UsageWindowSchema = Schema.Struct({
  used_percent: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const RateLimitBucketSchema = Schema.Struct({
  allowed: Schema.optional(Schema.Boolean),
  limit_reached: Schema.optional(Schema.Boolean),
  primary_window: Schema.optional(Schema.NullOr(UsageWindowSchema)),
  secondary_window: Schema.optional(Schema.NullOr(UsageWindowSchema)),
});
const CodexUsageSchema = Schema.Struct({
  rate_limit: Schema.optional(Schema.NullOr(RateLimitBucketSchema)),
});
export type CodexUsageResponse = typeof CodexUsageSchema.Type;
type UsageWindow = typeof UsageWindowSchema.Type;

export class CodexUsageError extends Schema.TaggedError<
  CodexUsageError,
  { readonly brand: unique symbol }
>()("CodexUsageError", {
  operation: Schema.Literals(["decode", "request"]),
  message: Schema.String,
}) {}

const boundedResetSeconds = (value: number | null | undefined): number | null =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 && value <= MAX_RESET_SECONDS
    ? value
    : null;

function resetSeconds(window: UsageWindow | null | undefined, now: number): number | null {
  const resetAfter = boundedResetSeconds(window?.reset_after_seconds);
  if (resetAfter !== null) return resetAfter;

  const resetAtValue = window?.reset_at;
  if (
    !Predicate.isNumber(resetAtValue) ||
    !Number.isFinite(resetAtValue) ||
    resetAtValue < 0 ||
    !Number.isFinite(now)
  )
    return null;

  const resetAt = resetAtValue > 100_000_000_000 ? resetAtValue / 1000 : resetAtValue;
  return boundedResetSeconds(Math.max(0, resetAt - now / 1000));
}

export function parseUsageSnapshot(data: CodexUsageResponse, now: number): UsageSnapshot {
  const primary = data.rate_limit?.primary_window ?? null;
  const secondary = data.rate_limit?.secondary_window ?? null;
  const fiveHour = secondary ? primary : null;
  const sevenDay = secondary ?? primary;
  return {
    capturedAt: now,
    fiveHourLeftPercent: usedToLeftPercent(fiveHour?.used_percent),
    sevenDayLeftPercent: usedToLeftPercent(sevenDay?.used_percent),
    fiveHourResetInSeconds: resetSeconds(fiveHour, now),
    sevenDayResetInSeconds: resetSeconds(sevenDay, now),
  };
}

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

function resetMoment(seconds: number | null, now: number) {
  if (!Predicate.isNumber(seconds) || !Number.isFinite(seconds) || !Number.isFinite(now))
    return undefined;
  const reset = DateTime.make(now + seconds * 1000);
  return Option.isSome(reset)
    ? { reset: reset.value, countdown: formatResetCountdown(seconds) }
    : undefined;
}

function formatShortReset(label: string, seconds: number | null, now: number): string | null {
  const at = resetMoment(seconds, now);
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

function usedToLeftPercent(value: number | null | undefined): number | null {
  return Predicate.isNumber(value) && Number.isFinite(value) ? clampPercent(100 - value) : null;
}

function formatTimestamp(value: number): string {
  return DateTime.formatLocal(DateTime.makeUnsafe(value), {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatTimestampOrNever(value: number | undefined): string {
  return value === undefined ? "never" : formatTimestamp(value);
}

function formatPercent(value: number | null): string {
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

function formatWindowedUsageLine(
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
    ? Arr.flatMapNullishOr(visible, (window) =>
        formatShortReset(
          window.label,
          remainingResetSeconds(window.resetInSeconds, capturedAt, now),
          now,
        ),
      )
    : [];
  return `Usage: ${labels.length ? labels.join(" | ") : "--"}${resets.length ? ` | ${resets.join(" | ")}` : ""}`;
}

export function formatUsageSnapshot(
  snapshot: UsageSnapshot,
  options: { readonly showResetTimes: boolean },
  now: number,
): string {
  return formatWindowedUsageLine(
    [
      {
        label: "5h",
        leftPercent: snapshot.fiveHourLeftPercent,
        resetInSeconds: snapshot.fiveHourResetInSeconds,
      },
      {
        label: "7d",
        leftPercent: snapshot.sevenDayLeftPercent,
        resetInSeconds: snapshot.sevenDayResetInSeconds,
      },
    ],
    options,
    now,
    snapshot.capturedAt,
  );
}

export function formatUsageDetails(snapshot: UsageSnapshot, now: number): string {
  return [
    "OpenAI subscription usage",
    `  5 hour: ${formatPercent(snapshot.fiveHourLeftPercent)} left`,
    `  7 day:  ${formatPercent(snapshot.sevenDayLeftPercent)} left`,
    `  Source: ${USAGE_URL}`,
    `  Updated: ${formatTimestamp(now)}`,
  ].join("\n");
}

export const requestCodexUsageWithCredentials = Effect.fn("CodexUsage.requestWithCredentials")(
  function* (credentials: CodexCredentials) {
    const http = yield* JsonHttpClient;
    const response = yield* http
      .request({
        url: USAGE_URL,
        headers: {
          accept: "*/*",
          authorization: `Bearer ${Redacted.value(credentials.accessToken)}`,
          "chatgpt-account-id": credentials.accountId,
        },
        responseSchema: CodexUsageSchema,
      })
      .pipe(
        Effect.mapError((error) => {
          const malformed = error.operation === "decode";
          return CodexUsageError.make({
            operation: malformed ? "decode" : "request",
            message: malformed
              ? "OpenAI returned an unreadable usage response"
              : "Usage request failed",
          });
        }),
      );
    if (Predicate.isTagged(response, "Rejected"))
      return yield* CodexUsageError.make({
        operation: "request",
        message: `Usage request failed with status ${response.status}`,
      });
    const now = yield* Clock.currentTimeMillis;
    return parseUsageSnapshot(response.body, now);
  },
);
