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

export const decodeAssistantUsage = <ValueInput>(
  value: ValueInput,
): DecodedAssistantUsage | undefined => decodeUnknownOrUndefined(AssistantUsageSchema, value);

export const decodeCompletedAssistantOutput = <MessageInput>(
  message: MessageInput,
): number | undefined =>
  decodeUnknownOrUndefined(CompletedAssistantOutputSchema, message)?.usage.output;

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

export const decodeContextUsage = <ValueInput>(
  value: ValueInput,
): DecodedContextUsage | undefined => decodeUnknownOrUndefined(ContextUsageSchema, value);

export const decodeHostCount = <ValueInput>(value: ValueInput): number | undefined =>
  decodeUnknownOrUndefined(NonNegativeFiniteNumberSchema, value);
