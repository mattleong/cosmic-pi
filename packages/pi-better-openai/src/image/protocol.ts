import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ImageOutputFormatSchema, type ImageOutputFormat } from "../config/schema.ts";
import {
  ImageModelSchema,
  type ExtractedImageResult,
  type ImageAction,
  type ImageInput,
  type ImageModel,
} from "./types.ts";

const ImageGenerationItemSchema = Schema.Struct({
  type: Schema.Literal("image_generation_call"),
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  revised_prompt: Schema.optional(Schema.String),
  result: Schema.optional(Schema.String),
  b64_json: Schema.optional(Schema.String),
});
const OutputItemDoneSchema = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: Schema.Struct({ type: Schema.String }),
});
const CompletedEventSchema = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: ImageGenerationItemSchema,
});
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
const EventDiscriminantSchema = Schema.Struct({ type: Schema.optional(Schema.String) });

type ImageGenerationItem = typeof ImageGenerationItemSchema.Type;

export type ImageStreamEvent =
  | { readonly _tag: "Image"; readonly image: ExtractedImageResult }
  | { readonly _tag: "ResponseFailed"; readonly message: string }
  | { readonly _tag: "ProviderError"; readonly message: string }
  | { readonly _tag: "Ignored" };

const ignoredEvent: ImageStreamEvent = { _tag: "Ignored" };

const imageData = (value: string, expectedMimeType: string) => {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(value);
  return {
    data: (match?.[1] ?? value).trim(),
    mimeType: expectedMimeType,
  };
};

const normalizeImageItem = (
  item: ImageGenerationItem,
  fallbackMimeType: string,
  fallbackId: string,
): ImageStreamEvent => {
  const raw = item.result?.trim() ? item.result : item.b64_json;
  if (!raw) return ignoredEvent;
  const base = {
    id: item.id ?? fallbackId,
    status: item.status ?? "completed",
    ...imageData(raw, fallbackMimeType),
  };
  return {
    _tag: "Image",
    image:
      item.revised_prompt === undefined ? base : { ...base, revisedPrompt: item.revised_prompt },
  };
};

export const decodeImageStreamEvent = Effect.fn("OpenAIImageProtocol.decodeEvent")(function* <
  Value,
>(value: Value, fallbackMimeType: string, fallbackId: string) {
  const discriminant = yield* Schema.decodeUnknownEffect(EventDiscriminantSchema)(value);
  if (discriminant.type === "response.output_item.done") {
    // Every output item completes this way; reasoning and message items carry no image.
    const done = yield* Schema.decodeUnknownEffect(OutputItemDoneSchema)(value);
    if (done.item.type !== "image_generation_call") return ignoredEvent;
    const event = yield* Schema.decodeUnknownEffect(CompletedEventSchema)(value);
    return normalizeImageItem(event.item, fallbackMimeType, fallbackId);
  }
  if (discriminant.type === "image_generation_call") {
    const item = yield* Schema.decodeUnknownEffect(ImageGenerationItemSchema)(value);
    return normalizeImageItem(item, fallbackMimeType, fallbackId);
  }
  if (discriminant.type === "response.failed") {
    const event = yield* Schema.decodeUnknownEffect(FailedEventSchema)(value);
    return {
      _tag: "ResponseFailed",
      message: event.response.error?.message ?? "Codex image request failed.",
    } as const;
  }
  if (discriminant.type === "error") {
    const event = yield* Schema.decodeUnknownEffect(ProviderErrorEventSchema)(value);
    return {
      _tag: "ProviderError",
      message: event.message ?? "Codex image request failed.",
    } as const;
  }
  if (
    discriminant.type === undefined &&
    (Predicate.hasProperty(value, "partial_image_b64") || Predicate.hasProperty(value, "b64_json"))
  ) {
    yield* Schema.decodeUnknownEffect(PartialEventSchema)(value);
    return ignoredEvent;
  }
  yield* Schema.decodeUnknownEffect(IgnoredEventSchema)(value);
  return ignoredEvent;
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
      model: ImageModelSchema,
      output_format: ImageOutputFormatSchema,
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

export function buildImageRequest(values: {
  readonly prompt: string;
  readonly model: string;
  readonly imageModel: ImageModel;
  readonly action: ImageAction;
  readonly outputFormat: ImageOutputFormat;
  readonly images: readonly ImageInput[];
}): ImageRequest {
  const content: Array<typeof InputContentSchema.Type> = [
    { type: "input_text", text: values.prompt },
  ];
  for (const image of values.images) {
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  const tool: ImageRequest["tools"][number] = {
    type: "image_generation",
    model: values.imageModel,
    output_format: values.outputFormat,
  };
  return {
    model: values.model,
    instructions: "",
    input: [{ role: "user", content }],
    tools: [values.action === "auto" ? tool : { ...tool, action: values.action }],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
    client_metadata: { "x-codex-installation-id": "pi-better-openai" },
  };
}
