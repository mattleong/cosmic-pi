import * as Predicate from "effect/Predicate";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  clampPercent,
  formatCompactReset,
  formatPercent,
  formatWindowedUsageLine,
  JsonHttpClient,
  remainingResetSeconds,
  usedToLeftPercent,
  type JsonHttpResponseSchema,
} from "pi-cosmic-core";
import { getXaiCredentials } from "../auth/auth.ts";

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

export class XaiUsageError extends Schema.TaggedError<XaiUsageError>()("XaiUsageError", {
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

function parseIsoToSecondsFromNow(value: string | undefined, now: number): number | null {
  if (!value?.trim()) return null;
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) return null;
  return Math.max(0, (DateTime.toEpochMillis(parsed.value) - now) / 1000);
}

export function parseMonthlyBilling<PayloadInput>(
  payload: PayloadInput,
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

export function parseWeeklyBilling<PayloadInput>(
  payload: PayloadInput,
  now: number,
): Pick<
  UsageSnapshot,
  "weeklyUsedPercent" | "weeklyLeftPercent" | "weeklyResetInSeconds" | "onDemandUsed"
> {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WeeklyBillingSchema)(payload));
  const config = decoded?.config;
  const weeklyUsedPercent = Predicate.isNumber(config?.creditUsagePercent)
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

export function parseUsageSnapshot<MonthlyPayloadInput>(
  monthlyPayload: MonthlyPayloadInput,
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

export function formatUsageSnapshot(
  snapshot: UsageSnapshot,
  options: { readonly showResetTimes: boolean },
  now: number,
): string {
  return formatWindowedUsageLine(
    [
      {
        label: "7d",
        leftPercent: snapshot.weeklyLeftPercent,
        resetInSeconds: snapshot.weeklyResetInSeconds,
      },
      {
        label: "mo",
        leftPercent: snapshot.monthlyLeftPercent,
        resetInSeconds: snapshot.monthlyResetInSeconds,
        includeDate: true,
      },
    ],
    options,
    now,
    snapshot.capturedAt,
  );
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

/**
 * Usage snapshot plus the redacted credential metadata resolved for the request.
 *
 * The metadata is carried out of the single credential resolution so callers never re-read the
 * auth file: registry-only credentials must not be reported as missing auth.
 */
interface XaiUsageResult {
  readonly snapshot: UsageSnapshot;
  readonly teamId?: string;
}

export const requestXaiUsage = Effect.fn("XaiUsage.requestXaiUsage")(function* (authPath: string) {
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
  const result: XaiUsageResult = (() => {
    const objectPart8888_0 = { snapshot: parseUsageSnapshot(decodedMonthly, decodedWeekly, now) };
    const objectPart8888_1 = credentials.teamId
      ? { ...objectPart8888_0, teamId: credentials.teamId }
      : objectPart8888_0;
    return objectPart8888_1;
  })();
  return result;
});
