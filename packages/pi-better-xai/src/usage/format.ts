import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  formatCompactReset,
  formatResetCountdown,
  JsonHttpClient,
  type JsonHttpResponseSchema,
} from "pi-cosmic-core";
import { getXaiCredentials } from "../auth/auth.ts";
import {
  provideModelRegistryAuth,
  type WithoutModelRegistry,
} from "../boundary/model-registry-auth.ts";

export const BILLING_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const MONTHLY_BILLING_URL = `${BILLING_BASE_URL}/billing`;
export const WEEKLY_BILLING_URL = `${BILLING_BASE_URL}/billing?format=credits`;

const NonNegativeFiniteSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);
const ProtocolPercentSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);
const MoneySchema = Schema.Struct({ val: NonNegativeFiniteSchema });
const MonthlyBillingSchema = Schema.Struct({
  config: Schema.Struct({
    monthlyLimit: Schema.optional(MoneySchema),
    used: Schema.optional(MoneySchema),
    onDemandCap: Schema.optional(MoneySchema),
    billingPeriodEnd: Schema.optional(Schema.String),
  }),
});
const WeeklyBillingSchema = Schema.Struct({
  config: Schema.Struct({
    currentPeriod: Schema.optional(
      Schema.Struct({
        end: Schema.optional(Schema.String),
      }),
    ),
    creditUsagePercent: Schema.optional(ProtocolPercentSchema),
    onDemandUsed: Schema.optional(MoneySchema),
    billingPeriodEnd: Schema.optional(Schema.String),
  }),
});

export class XaiUsageError extends Schema.TaggedErrorClass<XaiUsageError>()("XaiUsageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface UsageSnapshot {
  readonly capturedAt: number;
  readonly weeklyUsedPercent: number | null;
  readonly weeklyLeftPercent: number | null;
  readonly weeklyResetInSeconds: number | null;
  readonly monthlyUsed: number | null;
  readonly monthlyLimit: number | null;
  readonly monthlyUsedPercent: number | null;
  readonly monthlyLeftPercent: number | null;
  readonly monthlyResetInSeconds: number | null;
  readonly onDemandCap: number | null;
  readonly onDemandUsed: number | null;
  readonly isLimited: boolean;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function usedToLeftPercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return clampPercent(100 - value);
}

function parseIsoToSecondsFromNow(value: string | undefined, now: number): number | null {
  if (!value?.trim()) return null;
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) return null;
  return Math.max(0, (DateTime.toEpochMillis(parsed.value) - now) / 1000);
}

export { formatResetCountdown };

export function parseMonthlyBilling(
  payload: unknown,
  now: number,
): Pick<
  UsageSnapshot,
  | "monthlyUsed"
  | "monthlyLimit"
  | "monthlyUsedPercent"
  | "monthlyLeftPercent"
  | "monthlyResetInSeconds"
  | "onDemandCap"
> {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(MonthlyBillingSchema)(payload));
  const monthlyUsed = decoded?.config.used?.val ?? null;
  const monthlyLimit = decoded?.config.monthlyLimit?.val ?? null;
  const onDemandCap = decoded?.config.onDemandCap?.val ?? null;
  const monthlyUsedPercent =
    monthlyUsed !== null && monthlyLimit !== null && monthlyLimit > 0
      ? clampPercent((monthlyUsed / monthlyLimit) * 100)
      : null;
  return {
    monthlyUsed,
    monthlyLimit,
    monthlyUsedPercent,
    monthlyLeftPercent: usedToLeftPercent(monthlyUsedPercent),
    monthlyResetInSeconds: parseIsoToSecondsFromNow(decoded?.config.billingPeriodEnd, now),
    onDemandCap,
  };
}

export function parseWeeklyBilling(
  payload: unknown,
  now: number,
): Pick<
  UsageSnapshot,
  "weeklyUsedPercent" | "weeklyLeftPercent" | "weeklyResetInSeconds" | "onDemandUsed"
> {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WeeklyBillingSchema)(payload));
  const config = decoded?.config;
  const weeklyUsedPercent =
    typeof config?.creditUsagePercent === "number"
      ? clampPercent(config.creditUsagePercent)
      : config
        ? 0
        : null;
  const resetIso = config?.billingPeriodEnd ?? config?.currentPeriod?.end;
  return {
    weeklyUsedPercent,
    weeklyLeftPercent: usedToLeftPercent(weeklyUsedPercent),
    weeklyResetInSeconds: parseIsoToSecondsFromNow(resetIso, now),
    onDemandUsed: config?.onDemandUsed?.val ?? null,
  };
}

export function parseUsageSnapshot(
  monthlyPayload: unknown,
  weeklyPayload: unknown | null | undefined,
  now: number,
): UsageSnapshot {
  const monthly = parseMonthlyBilling(monthlyPayload, now);
  const weekly = parseWeeklyBilling(weeklyPayload ?? {}, now);
  return {
    capturedAt: now,
    ...weekly,
    ...monthly,
    isLimited:
      (weekly.weeklyUsedPercent !== null && weekly.weeklyUsedPercent >= 100) ||
      (monthly.monthlyUsed !== null &&
        monthly.monthlyLimit !== null &&
        monthly.monthlyUsed >= monthly.monthlyLimit),
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
  options: { readonly showResetTimes: boolean },
  now: number,
): string {
  const hasWeekly = snapshot.weeklyLeftPercent !== null || snapshot.weeklyResetInSeconds !== null;
  const hasMonthly =
    snapshot.monthlyLeftPercent !== null || snapshot.monthlyResetInSeconds !== null;
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

export function formatUsageDetails(snapshot: UsageSnapshot, now: number): string {
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

const fetchBilling = Effect.fn("XaiUsage.fetchBilling")(function* <A, R>(
  url: string,
  accessToken: string,
  responseSchema: JsonHttpResponseSchema<A, R>,
) {
  const http = yield* JsonHttpClient;
  return yield* http.request({
    url,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    responseSchema,
  });
});

const requestXaiUsageEffect = Effect.fn("XaiUsage.requestXaiUsage")(function* (authPath: string) {
  const credentials = yield* getXaiCredentials(authPath);
  if (!credentials) return undefined;
  const [monthly, weekly] = yield* Effect.all(
    [
      fetchBilling(MONTHLY_BILLING_URL, credentials.accessToken, MonthlyBillingSchema).pipe(
        Effect.mapError((error) =>
          error.operation === "decode"
            ? new XaiUsageError({
                operation: "monthly-decode",
                message: "xAI monthly billing response was malformed.",
              })
            : new XaiUsageError({
                operation: "request",
                message: "xAI billing request failed.",
              }),
        ),
      ),
      fetchBilling(WEEKLY_BILLING_URL, credentials.accessToken, WeeklyBillingSchema).pipe(
        Effect.catch(() => Effect.void),
      ),
    ] as const,
    { concurrency: 2 },
  );
  if (monthly._tag === "Rejected") {
    return yield* new XaiUsageError({
      operation: "monthly",
      message: `xAI monthly billing request failed (HTTP ${monthly.status}).`,
    });
  }
  const decodedMonthly = monthly.body;
  const decodedWeekly = weekly?._tag === "Accepted" ? weekly.body : undefined;
  const now = yield* Clock.currentTimeMillis;
  return parseUsageSnapshot(decodedMonthly, decodedWeekly, now);
});

export function requestXaiUsage(authPath: string): ReturnType<typeof requestXaiUsageEffect>;
export function requestXaiUsage(
  authPath: string,
  ctx: Pick<ExtensionContext, "modelRegistry">,
): WithoutModelRegistry<ReturnType<typeof requestXaiUsageEffect>>;
export function requestXaiUsage(authPath: string, ctx?: Pick<ExtensionContext, "modelRegistry">) {
  const effect = requestXaiUsageEffect(authPath);
  return ctx ? provideModelRegistryAuth(effect, ctx) : effect;
}
