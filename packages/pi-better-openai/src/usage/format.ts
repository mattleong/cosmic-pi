import * as Predicate from "effect/Predicate";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  formatPercent,
  formatWindowedUsageLine,
  JsonHttpClient,
  usedToLeftPercent,
} from "pi-cosmic-core";
import type { CodexCredentialsWithSource } from "../auth/codex-auth.ts";

export type UsageScope = "default" | "spark";
export type UsageSnapshot = {
  capturedAt: number;
  scope: UsageScope;
  fiveHourLeftPercent: number | null;
  sevenDayLeftPercent: number | null;
  fiveHourResetInSeconds: number | null;
  sevenDayResetInSeconds: number | null;
  isLimited: boolean;
};
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SPARK_MODEL_ID = "gpt-5.3-codex-spark";
const SPARK_LIMIT_NAME = "GPT-5.3-Codex-Spark";

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
const AdditionalEntrySchema = Schema.Struct({
  limit_name: Schema.optional(Schema.String),
  rate_limit: Schema.optional(Schema.NullOr(RateLimitBucketSchema)),
});
const CodexUsageSchema = Schema.Struct({
  rate_limit: Schema.optional(Schema.NullOr(RateLimitBucketSchema)),
  additional_rate_limits: Schema.optional(
    Schema.NullOr(
      Schema.Union([Schema.Array(Schema.Unknown), Schema.Record(Schema.String, Schema.Unknown)]),
    ),
  ),
});
export type CodexUsageResponse = typeof CodexUsageSchema.Type;
type UsageWindow = typeof UsageWindowSchema.Type;
type RateLimitBucket = typeof RateLimitBucketSchema.Type;

export class CodexUsageError extends Schema.TaggedError<CodexUsageError>()("CodexUsageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const normalizeBucket = <Value>(value: Value): RateLimitBucket | null =>
  Option.getOrUndefined(Schema.decodeUnknownOption(RateLimitBucketSchema)(value)) ?? null;

function sparkBucket(data: CodexUsageResponse): RateLimitBucket | null {
  const additional = data.additional_rate_limits;
  const values = Array.isArray(additional)
    ? additional
    : additional
      ? Object.values(additional)
      : [];
  for (const value of values) {
    const entry = Option.getOrUndefined(Schema.decodeUnknownOption(AdditionalEntrySchema)(value));
    if (entry?.limit_name === SPARK_LIMIT_NAME && entry.rate_limit) return entry.rate_limit;
  }
  return null;
}

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

export const usageScopeForModel = (modelId: string | undefined): UsageScope =>
  modelId === SPARK_MODEL_ID ? "spark" : "default";

export function parseUsageSnapshot<PayloadInput>(
  payload: PayloadInput,
  modelId: string | undefined,
  now: number,
): UsageSnapshot {
  const data = Option.getOrUndefined(Schema.decodeUnknownOption(CodexUsageSchema)(payload)) ?? {};
  const scope = usageScopeForModel(modelId);
  const bucket =
    scope === "spark"
      ? (sparkBucket(data) ?? normalizeBucket(data.rate_limit))
      : normalizeBucket(data.rate_limit);
  const primary = bucket?.primary_window ?? null;
  const secondary = bucket?.secondary_window ?? null;
  const fiveHour = secondary ? primary : null;
  const sevenDay = secondary ?? primary;
  return {
    capturedAt: now,
    scope,
    fiveHourLeftPercent: usedToLeftPercent(fiveHour?.used_percent),
    sevenDayLeftPercent: usedToLeftPercent(sevenDay?.used_percent),
    fiveHourResetInSeconds: resetSeconds(fiveHour, now),
    sevenDayResetInSeconds: resetSeconds(sevenDay, now),
    isLimited: bucket?.limit_reached === true || bucket?.allowed === false,
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
        includeDate: true,
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
    `  Updated: ${DateTime.formatLocal(DateTime.makeUnsafe(now))}`,
  ].join("\n");
}

export interface CodexUsageResult {
  readonly snapshot: UsageSnapshot;
  readonly credential: {
    readonly source: "modelRegistry" | "authFile";
    readonly accountId: string;
  };
}

export const requestCodexUsageWithCredentials = Effect.fn("CodexUsage.requestWithCredentials")(
  function* (credentials: CodexCredentialsWithSource, modelId?: string) {
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
              ? "Codex usage response was malformed."
              : "Codex usage request failed.",
          });
        }),
      );
    if (response._tag === "Rejected")
      return yield* new CodexUsageError({
        operation: "request",
        message: `Codex usage request failed (${response.status})`,
      });
    const now = yield* Clock.currentTimeMillis;
    return {
      snapshot: parseUsageSnapshot(response.body, modelId, now),
      credential: { source: credentials.source, accountId: credentials.accountId },
    } satisfies CodexUsageResult;
  },
);
