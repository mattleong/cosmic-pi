import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { FooterTotals } from "../footer/builtin-contributions.ts";

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
  input: NonNegativeFiniteNumberSchema,
  output: NonNegativeFiniteNumberSchema,
  cacheRead: NonNegativeFiniteNumberSchema,
  cacheWrite: NonNegativeFiniteNumberSchema,
  cost: NonNegativeFiniteNumberSchema,
});

const ContextUsageSchema = Schema.Struct({
  tokens: Schema.NullOr(NonNegativeFiniteNumberSchema),
  contextWindow: NonNegativeFiniteNumberSchema,
  percent: Schema.NullOr(NonNegativeFiniteNumberSchema),
});

export type DecodedAssistantUsage = typeof AssistantUsageSchema.Type;
export type DecodedContextUsage = typeof ContextUsageSchema.Type;

const decode = <S extends Schema.ConstraintDecoder<unknown>, ValueInput>(
  schema: S,
  value: ValueInput,
): S["Type"] | undefined => Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

/** Decode one assistant usage record before it enters session-total arithmetic. */
export const decodeAssistantUsage = <ValueInput>(
  value: ValueInput,
): DecodedAssistantUsage | undefined => decode(AssistantUsageSchema, value);

/**
 * Adds a decoded usage record only when every aggregate remains non-negative and finite.
 * Returning undefined leaves the caller's last complete totals untouched.
 */
export const addAssistantUsage = (
  totals: FooterTotals,
  usage: DecodedAssistantUsage,
): FooterTotals | undefined =>
  decode(FooterTotalsSchema, {
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    cost: totals.cost + usage.cost.total,
  });

/** Decode the complete host context-usage snapshot before footer rendering. */
export const decodeContextUsage = <ValueInput>(
  value: ValueInput,
): DecodedContextUsage | undefined => decode(ContextUsageSchema, value);

/** Decode one non-negative finite host model/count value. */
export const decodeHostCount = <ValueInput>(value: ValueInput): number | undefined =>
  decode(NonNegativeFiniteNumberSchema, value);
