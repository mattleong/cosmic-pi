import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  clampPercent,
  formatCompactReset,
  formatPercent,
  formatWindowedUsageLine,
  remainingResetSeconds,
  usedToLeftPercent,
} from "pi-cosmic-core";

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
export const MonthlyBillingSchema = Schema.Struct({
  config: Schema.Struct({
    monthlyLimit: Schema.optional(MoneySchema),
    used: Schema.optional(MoneySchema),
    onDemandCap: Schema.optional(MoneySchema),
    billingPeriodEnd: Schema.optional(Schema.String),
  }),
});
export const WeeklyBillingSchema = Schema.Struct({
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

type MonthlyBillingBody = typeof MonthlyBillingSchema.Type;
type WeeklyBillingBody = typeof WeeklyBillingSchema.Type;

export interface UsageSnapshot {
  readonly capturedAt: number;
  readonly weeklyUsedPercent: number | null;
  readonly weeklyLeftPercent: number | null;
  readonly weeklyResetInSeconds: number | null;
  readonly monthlyUsed: number | null;
  readonly monthlyLimit: number | null;
  readonly monthlyLeftPercent: number | null;
  readonly monthlyResetInSeconds: number | null;
  readonly onDemandCap: number | null;
  readonly onDemandUsed: number | null;
}

function parseIsoToSecondsFromNow(value: string | undefined, now: number): number | null {
  if (!value?.trim()) return null;
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed)) return null;
  return Math.max(0, (DateTime.toEpochMillis(parsed.value) - now) / 1000);
}

export function parseMonthlyBilling(
  payload: MonthlyBillingBody,
  now: number,
): Pick<
  UsageSnapshot,
  "monthlyUsed" | "monthlyLimit" | "monthlyLeftPercent" | "monthlyResetInSeconds" | "onDemandCap"
> {
  const monthlyUsed = payload.config.used?.val ?? null;
  const monthlyLimit = payload.config.monthlyLimit?.val ?? null;
  const onDemandCap = payload.config.onDemandCap?.val ?? null;
  const monthlyUsedPercent =
    monthlyUsed !== null && monthlyLimit !== null && monthlyLimit > 0
      ? clampPercent((monthlyUsed / monthlyLimit) * 100)
      : null;
  return {
    monthlyUsed,
    monthlyLimit,
    monthlyLeftPercent: usedToLeftPercent(monthlyUsedPercent),
    monthlyResetInSeconds: parseIsoToSecondsFromNow(payload.config.billingPeriodEnd, now),
    onDemandCap,
  };
}

export function parseWeeklyBilling(
  payload: WeeklyBillingBody | undefined,
  now: number,
): Pick<
  UsageSnapshot,
  "weeklyUsedPercent" | "weeklyLeftPercent" | "weeklyResetInSeconds" | "onDemandUsed"
> {
  const config = payload?.config;
  // A decodable payload without creditUsagePercent is "unknown", not "0 used":
  // rendering 0 would claim certainty ("100% left") the provider never reported.
  const weeklyUsedPercent = config?.creditUsagePercent ?? null;
  const resetIso = config?.billingPeriodEnd ?? config?.currentPeriod?.end;
  return {
    weeklyUsedPercent,
    weeklyLeftPercent: usedToLeftPercent(weeklyUsedPercent),
    weeklyResetInSeconds: parseIsoToSecondsFromNow(resetIso, now),
    onDemandUsed: config?.onDemandUsed?.val ?? null,
  };
}

export function parseUsageSnapshot(
  monthlyPayload: MonthlyBillingBody,
  weeklyPayload: WeeklyBillingBody | null | undefined,
  now: number,
): UsageSnapshot {
  const monthly = parseMonthlyBilling(monthlyPayload, now);
  const weekly = parseWeeklyBilling(weeklyPayload ?? undefined, now);
  return { capturedAt: now, ...weekly, ...monthly };
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
    snapshot.onDemandCap === null || snapshot.onDemandCap <= 0
      ? "disabled"
      : snapshot.onDemandUsed === null
        ? "unavailable"
        : `$${snapshot.onDemandUsed / 100} / $${snapshot.onDemandCap / 100}`;
  return [
    "xAI subscription usage",
    `  Weekly:  ${weeklyUsed} (${weeklyLeft} left)${weeklyReset ? `  · ${weeklyReset}` : ""}`,
    `  Monthly: ${monthly} (${monthlyLeft} left)${monthlyReset ? `  · ${monthlyReset}` : ""}`,
    `  On-demand: ${onDemand}`,
    `  Source: ${MONTHLY_BILLING_URL}`,
  ].join("\n");
}
