import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const OPENAI_COMPACTION_DETAILS_TYPE = "pi-better-openai.compaction.v1";
export const OPENAI_COMPACTION_SUMMARY =
  "OpenAI created a native encrypted context checkpoint. The original Pi session history remains available for tree navigation.";

const NonNegativeIntSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const UsageSchema = Schema.Struct({
  inputTokens: NonNegativeIntSchema,
  outputTokens: NonNegativeIntSchema,
  totalTokens: NonNegativeIntSchema,
});

export const OpenAICompactionCheckpointSchema = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.Literal("openai"),
  api: Schema.Literal("openai-responses"),
  model: Schema.String,
  output: Schema.Array(JsonObjectSchema),
  rawInputCount: NonNegativeIntSchema,
  createdAt: NonNegativeIntSchema,
  tokensBefore: NonNegativeIntSchema,
  usage: Schema.optional(UsageSchema),
});

export const OpenAICompactionDetailsSchema = Schema.Struct({
  type: Schema.Literal(OPENAI_COMPACTION_DETAILS_TYPE),
  checkpoint: OpenAICompactionCheckpointSchema,
});

export type OpenAICompactionJsonObject = typeof JsonObjectSchema.Type;
export type OpenAICompactionCheckpoint = typeof OpenAICompactionCheckpointSchema.Type;
export type OpenAICompactionDetails = typeof OpenAICompactionDetailsSchema.Type;

export function decodeOpenAICompactionDetails<ValueInput>(
  value: ValueInput,
): OpenAICompactionDetails | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(OpenAICompactionDetailsSchema)(value));
}
