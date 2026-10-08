import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";

const NonNegativeFiniteNumberSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isGreaterThanOrEqualTo(0),
);

const AssistantUsageSchema = Schema.Struct({
  input: NonNegativeFiniteNumberSchema,
  output: NonNegativeFiniteNumberSchema,
  cacheRead: NonNegativeFiniteNumberSchema,
  cacheWrite: NonNegativeFiniteNumberSchema,
  cost: Schema.Struct({ total: NonNegativeFiniteNumberSchema }),
});

const FooterTotalsSchema = Schema.Struct({
  ...AssistantUsageSchema.fields,
  cost: NonNegativeFiniteNumberSchema,
});

const ContextUsageSchema = Schema.Struct({
  tokens: Schema.NullOr(NonNegativeFiniteNumberSchema),
  contextWindow: NonNegativeFiniteNumberSchema,
  percent: Schema.NullOr(NonNegativeFiniteNumberSchema),
});

export type FooterTotals = typeof FooterTotalsSchema.Type;
export type DecodedAssistantUsage = typeof AssistantUsageSchema.Type;
export type DecodedContextUsage = typeof ContextUsageSchema.Type;

/** Decode one assistant usage record before it enters session-total arithmetic. */
export const decodeAssistantUsage = <ValueInput>(
  value: ValueInput,
): DecodedAssistantUsage | undefined => decodeUnknownOrUndefined(AssistantUsageSchema, value);

/**
 * Adds a decoded usage record only when every aggregate remains non-negative and finite.
 * Returning undefined leaves the caller's last complete totals untouched.
 */
export const addAssistantUsage = (
  totals: FooterTotals,
  usage: DecodedAssistantUsage,
): FooterTotals | undefined =>
  decodeUnknownOrUndefined(FooterTotalsSchema, {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    cost: totals.cost + usage.cost.total,
  });

/** Decode the complete host context-usage snapshot before footer rendering. */
export const decodeContextUsage = <ValueInput>(
  value: ValueInput,
): DecodedContextUsage | undefined => decodeUnknownOrUndefined(ContextUsageSchema, value);

/** Decode one non-negative finite host model/count value. */
export const decodeHostCount = <ValueInput>(value: ValueInput): number | undefined =>
  decodeUnknownOrUndefined(NonNegativeFiniteNumberSchema, value);
