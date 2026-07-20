import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ImageGenerationItemFields = {
  type: Schema.Literal("image_generation_call"),
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  revised_prompt: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  b64_json: Schema.optional(Schema.String),
};
export const ImageGenerationItemSchema = Schema.Struct(ImageGenerationItemFields);
const CompletedEventSchema = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: ImageGenerationItemSchema,
});
const ItemEventSchema = Schema.Struct(ImageGenerationItemFields);
const PartialEventSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  partial_image_b64: Schema.optional(Schema.String),
  b64_json: Schema.optional(Schema.String),
});
const FailedEventSchema = Schema.Struct({
  type: Schema.Literal("response.failed"),
  response: Schema.Struct({
    error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
  }),
});
const ProviderErrorEventSchema = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.optional(Schema.String),
});
const IgnoredEventSchema = Schema.Struct({ type: Schema.String });
export const ImageStreamEventSchema = Schema.Union([
  CompletedEventSchema,
  ItemEventSchema,
  PartialEventSchema,
  FailedEventSchema,
  ProviderErrorEventSchema,
  IgnoredEventSchema,
]);
export type ImageStreamEvent = typeof ImageStreamEventSchema.Type;

const EventDiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });
export const decodeImageStreamEvent = Effect.fn("OpenAIImageProtocol.decodeEvent")(function* (
  value: unknown,
) {
  const discriminant = yield* Schema.decodeUnknownEffect(EventDiscriminantSchema)(value);
  const schema =
    discriminant.type === "response.output_item.done"
      ? CompletedEventSchema
      : discriminant.type === "image_generation_call"
        ? ItemEventSchema
        : discriminant.type === "response.failed"
          ? FailedEventSchema
          : discriminant.type === "error"
            ? ProviderErrorEventSchema
            : discriminant.type === undefined &&
                typeof value === "object" &&
                value !== null &&
                ("partial_image_b64" in value || "b64_json" in value)
              ? PartialEventSchema
              : IgnoredEventSchema;
  return yield* Schema.decodeUnknownEffect(schema)(value);
});

const InputContentSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("input_image"),
    detail: Schema.Literal("auto"),
    image_url: Schema.String,
  }),
]);
export const ImageRequestSchema = Schema.Struct({
  model: Schema.String,
  instructions: Schema.String,
  input: Schema.Array(
    Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(InputContentSchema) }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      type: Schema.Literal("image_generation"),
      output_format: Schema.Literals(["png", "jpeg", "webp"]),
      action: Schema.optional(Schema.Literals(["generate", "edit"])),
    }),
  ),
  tool_choice: Schema.Struct({ type: Schema.Literal("image_generation") }),
  parallel_tool_calls: Schema.Boolean,
  store: Schema.Boolean,
  stream: Schema.Boolean,
  include: Schema.Array(Schema.Unknown),
  client_metadata: Schema.Record(Schema.String, Schema.String),
});
export type ImageRequest = typeof ImageRequestSchema.Type;
