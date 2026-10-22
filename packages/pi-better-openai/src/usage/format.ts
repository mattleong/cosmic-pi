import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  formatPercent,
  formatWindowedUsageLine,
  JsonHttpClient,
  usedToLeftPercent,
  formatTimestamp,
} from "pi-cosmic-core";
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
  used_percent: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
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

export class CodexUsageError extends Schema.TaggedError<CodexUsageError>()("CodexUsageError", {
  operation: Schema.String,
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
          return new CodexUsageError({
            operation: malformed ? "decode" : "request",
            message: malformed
              ? "OpenAI returned an unreadable usage response"
              : "Usage request failed",
          });
        }),
      );
    if (Predicate.isTagged(response, "Rejected"))
      return yield* new CodexUsageError({
        operation: "request",
        message: `Usage request failed with status ${response.status}`,
      });
    const now = yield* Clock.currentTimeMillis;
    return parseUsageSnapshot(response.body, now);
  },
);
