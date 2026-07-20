import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { JsonHttpClient } from "pi-cosmic-core";
import { getCodexCredentials, type CodexCredentialsWithSource } from "./codex-auth.ts";

export { readCodexAuth } from "./codex-auth.ts";
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

export class CodexUsageError extends Schema.TaggedErrorClass<CodexUsageError>()("CodexUsageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));
const usedToLeftPercent = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? clampPercent(100 - value) : null;

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

function formatCompactReset(
  label: string,
  seconds: number | null,
  options: { readonly includeDate?: boolean } | undefined,
  now: number,
): string | null {
  const countdown = formatResetCountdown(seconds);
  const clock = formatResetClock(seconds, options, now);
  return countdown && clock ? `${label} ↺ ${countdown} - ${clock}` : null;
}

const normalizeBucket = (value: unknown): RateLimitBucket | null =>
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

function resetSeconds(window: UsageWindow | null | undefined, now: number): number | null {
  if (
    typeof window?.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds)
  )
    return window.reset_after_seconds;
  if (typeof window?.reset_at !== "number" || !Number.isFinite(window.reset_at)) return null;
  const resetAt = window.reset_at > 100_000_000_000 ? window.reset_at / 1000 : window.reset_at;
  return Math.max(0, resetAt - now / 1000);
}

export const usageScopeForModel = (modelId: string | undefined): UsageScope =>
  modelId === SPARK_MODEL_ID ? "spark" : "default";

export function parseUsageSnapshot(
  payload: unknown,
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

export const formatPercent = (value: number | null): string =>
  typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
const remaining = (seconds: number | null, capturedAt: number, now: number) =>
  seconds === null ? null : seconds - (now - capturedAt) / 1000;

export function formatUsageSnapshot(
  snapshot: UsageSnapshot,
  options: { readonly showResetTimes: boolean },
  now: number,
): string {
  const hasFive = snapshot.fiveHourLeftPercent !== null || snapshot.fiveHourResetInSeconds !== null;
  const hasSeven =
    snapshot.sevenDayLeftPercent !== null || snapshot.sevenDayResetInSeconds !== null;
  const windows = [
    hasFive ? `5h: ${formatPercent(snapshot.fiveHourLeftPercent)}` : null,
    hasSeven ? `7d: ${formatPercent(snapshot.sevenDayLeftPercent)}` : null,
  ].filter((value): value is string => value !== null);
  const resets = options.showResetTimes
    ? [
        hasFive
          ? formatCompactReset(
              "5h",
              remaining(snapshot.fiveHourResetInSeconds, snapshot.capturedAt, now),
              undefined,
              now,
            )
          : null,
        hasSeven
          ? formatCompactReset(
              "7d",
              remaining(snapshot.sevenDayResetInSeconds, snapshot.capturedAt, now),
              { includeDate: true },
              now,
            )
          : null,
      ].filter((value): value is string => value !== null)
    : [];
  return `Usage: ${windows.length ? windows.join(" | ") : "--"}${resets.length ? ` | ${resets.join(" | ")}` : ""}`;
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
          authorization: `Bearer ${credentials.accessToken}`,
          "chatgpt-account-id": credentials.accountId,
        },
      })
      .pipe(
        Effect.mapError(
          () =>
            new CodexUsageError({ operation: "request", message: "Codex usage request failed." }),
        ),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* new CodexUsageError({
        operation: "request",
        message: `Codex usage request failed (${response.status})`,
      });
    const decoded = yield* Schema.decodeUnknownEffect(CodexUsageSchema)(response.body).pipe(
      Effect.mapError(
        () =>
          new CodexUsageError({
            operation: "decode",
            message: "Codex usage response was malformed.",
          }),
      ),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      snapshot: parseUsageSnapshot(decoded, modelId, now),
      credential: { source: credentials.source, accountId: credentials.accountId },
    } satisfies CodexUsageResult;
  },
);

export const requestCodexUsageResult = Effect.fn("CodexUsage.requestResult")(function* (
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
  modelId?: string,
) {
  const credentials = yield* getCodexCredentials(authPath, ctx);
  if (!credentials) return undefined;
  return yield* requestCodexUsageWithCredentials(credentials, modelId);
});

export const requestCodexUsage = Effect.fn("CodexUsage.request")(function* (
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
  modelId?: string,
) {
  const result = yield* requestCodexUsageResult(authPath, ctx, modelId);
  return result?.snapshot;
});
