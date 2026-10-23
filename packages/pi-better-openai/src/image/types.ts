import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { JsonObject, JsonValue } from "pi-cosmic-core";
import { toolArgumentPreparer } from "pi-cosmic-core/tool-arguments";
import type { Static } from "typebox";
import {
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  ImageOutputFormatSchema,
  type ImageOutputFormat,
} from "../config/schema.ts";

export const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] as const;
export const ImageModelSchema = Schema.Literals(IMAGE_MODELS);
export type ImageModel = typeof ImageModelSchema.Type;
export const DEFAULT_IMAGE_MODEL: ImageModel = "gpt-image-2.5-sunburst";

export const MAX_IMAGE_INPUTS = 5;
export const IMAGE_ACTIONS = ["auto", "generate", "edit"] as const;
export type ImageAction = (typeof IMAGE_ACTIONS)[number];

const PROMPT_MAX_LENGTH = 32_768;
const PATH_MAX_LENGTH = 4_096;
const MODEL_MAX_LENGTH = 256;
// Nonblank text is checked by argument preparation: providers such as llama.cpp reject `pattern`.
const boundedJsonString = (maximum: number) => ({
  type: "string" as const,
  minLength: 1,
  maxLength: maximum,
});
export const TOOL_PARAMS = {
  type: "object",
  properties: {
    prompt: {
      ...boundedJsonString(PROMPT_MAX_LENGTH),
      description:
        "Image generation/editing prompt. Pass the user's wording verbatim unless they explicitly ask you to refine or expand it.",
    },
    action: { type: "string", enum: IMAGE_ACTIONS },
    images: {
      type: "array",
      maxItems: MAX_IMAGE_INPUTS,
      items: boundedJsonString(PATH_MAX_LENGTH),
    },
    model: {
      ...boundedJsonString(MODEL_MAX_LENGTH),
      description:
        "Mainline Codex model override, for example openai-codex/gpt-6.1-sol. Use imageModel to select the hosted image model.",
    },
    imageModel: {
      type: "string",
      enum: IMAGE_MODELS,
      description:
        "Hosted image model. Defaults to gpt-image-2.5-sunburst for generation and precise editing; choose gpt-image-2.5-flare for faster generation.",
    },
    outputFormat: { type: "string", enum: IMAGE_OUTPUT_FORMATS },
    save: { type: "string", enum: IMAGE_SAVE_MODES },
    saveDir: boundedJsonString(PATH_MAX_LENGTH),
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;
export type ToolParams = Static<typeof TOOL_PARAMS>;

const decodeArgumentsObject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.MutableJson),
);
const isBlankEntry = (entry: JsonValue) =>
  entry === null || (Predicate.isString(entry) && entry.trim().length === 0);

// Blank entries in `images` name no file, so they are dropped like blank optional fields.
const withoutBlankImages = ({ images, ...rest }: JsonObject): JsonObject => {
  if (!Array.isArray(images)) return images === undefined ? rest : { ...rest, images };
  const named = images.filter((entry) => !isBlankEntry(entry));
  return named.length > 0 ? { ...rest, images: named } : rest;
};

/**
 * Pi `prepareArguments` hook for openai_image: drops null and blank optional fields and blank
 * image paths, then validates with errors that name the offending field.
 */
export const prepareImageArguments = flow(
  decodeArgumentsObject,
  Option.map(withoutBlankImages),
  // Anything but a JSON object is left for the preparer to reject.
  Option.getOrUndefined,
  toolArgumentPreparer("openai_image", TOOL_PARAMS),
);
export type ImageInput = {
  readonly data: string;
  readonly mimeType: string;
};
export type CodexImageResult = {
  id: string;
  status: string;
  prompt: string;
  revisedPrompt?: string;
  data: string;
  mimeType: string;
  savedPath?: string;
  model: string;
  imageModel?: string;
  action: ImageAction;
  outputFormat: ImageOutputFormat;
  /** Why the result differs from the request, such as a different returned format. */
  note?: string;
};
export const CodexImageDetailsSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  prompt: Schema.String,
  revisedPrompt: Schema.optional(Schema.String),
  mimeType: Schema.String,
  savedPath: Schema.optional(Schema.String),
  model: Schema.String,
  imageModel: Schema.optional(Schema.String),
  action: Schema.Literals(IMAGE_ACTIONS),
  outputFormat: ImageOutputFormatSchema,
  note: Schema.optional(Schema.String),
});
export type CodexImageDetails = typeof CodexImageDetailsSchema.Type;

export type ExtractedImageResult = Omit<
  CodexImageResult,
  "prompt" | "savedPath" | "model" | "imageModel" | "action" | "outputFormat"
>;

const OpenAIImageOperationSchema = Schema.Literals([
  "auth",
  "config",
  "context",
  "input",
  "params",
  "request",
  "response",
  "save",
  "sharp",
  "stream",
  "timeout",
]);
type OpenAIImageOperation = typeof OpenAIImageOperationSchema.Type;

export class OpenAIImageError extends Schema.TaggedError<
  OpenAIImageError,
  { readonly brand: unique symbol }
>()("OpenAIImageError", {
  operation: OpenAIImageOperationSchema,
  message: Schema.String,
}) {}
export const fail = (operation: OpenAIImageOperation, message: string) =>
  new OpenAIImageError({ operation, message });
export const failWith = (operation: OpenAIImageOperation, message: string) => () =>
  fail(operation, message);
