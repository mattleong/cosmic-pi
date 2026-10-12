import { flow } from "effect/Function";
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

const CompletedAssistantOutputSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  stopReason: Schema.Literals(["stop", "toolUse", "length"]),
  usage: Schema.Struct({ output: Schema.Int.check(Schema.isGreaterThan(0)) }),
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

export const decodeAssistantUsage = decodeUnknownOrUndefined(AssistantUsageSchema);

export const decodeCompletedAssistantOutput = flow(
  decodeUnknownOrUndefined(CompletedAssistantOutputSchema),
  (completed) => completed?.usage.output,
);

const decodeFooterTotals = decodeUnknownOrUndefined(FooterTotalsSchema);

export const addAssistantUsage = (
  totals: FooterTotals,
  usage: DecodedAssistantUsage,
): FooterTotals | undefined =>
  decodeFooterTotals({
    input: totals.input + usage.input,
    output: totals.output + usage.output,
    cacheRead: totals.cacheRead + usage.cacheRead,
    cacheWrite: totals.cacheWrite + usage.cacheWrite,
    cost: totals.cost + usage.cost.total,
  });

export const decodeContextUsage = decodeUnknownOrUndefined(ContextUsageSchema);

export const decodeHostCount = decodeUnknownOrUndefined(NonNegativeFiniteNumberSchema);
