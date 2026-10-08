import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const OPENAI_COMPACTION_DETAILS_TYPE = "pi-better-openai.compaction.v1";
export const OPENAI_COMPACTION_SUMMARY =
  "OpenAI created a native encrypted context checkpoint. The original Pi session history remains available for tree navigation.";

export const NonNegativeIntSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
export const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const UsageSchema = Schema.Struct({
  inputTokens: NonNegativeIntSchema,
  cachedInputTokens: Schema.optional(NonNegativeIntSchema),
  outputTokens: NonNegativeIntSchema,
  totalTokens: NonNegativeIntSchema,
});

const OpenAICompactionCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.Literal("openai"),
  api: Schema.Literal("openai-responses"),
  model: Schema.String,
  output: Schema.Array(JsonObjectSchema),
  rawInputCount: NonNegativeIntSchema,
  omittedEntryIds: Schema.optional(Schema.Array(Schema.String)),
  createdAt: NonNegativeIntSchema,
  tokensBefore: NonNegativeIntSchema,
  usage: Schema.optional(UsageSchema),
});

const OpenAICompactionDetailsSchema = Schema.Struct({
  type: Schema.Literal(OPENAI_COMPACTION_DETAILS_TYPE),
  checkpoint: OpenAICompactionCheckpointSchema,
});

export type OpenAICompactionJsonObject = typeof JsonObjectSchema.Type;
export type OpenAICompactionCheckpoint = typeof OpenAICompactionCheckpointSchema.Type;

// Ownership detection fails closed: a throwing value is not silently treated as unowned.
export const decodeOpenAICompactionDetails = <Value>(raw: Value) =>
  Option.getOrUndefined(Schema.decodeUnknownOption(OpenAICompactionDetailsSchema)(raw));
