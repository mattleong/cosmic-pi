import * as Schema from "effect/Schema";
import {
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
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
// Nonblank text is checked by ToolParamsSchema: providers such as llama.cpp reject `pattern`.
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
        "Mainline Codex model override, for example openai-codex/gpt-5.5. Use imageModel to select the hosted image model.",
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
const boundedString = (maximum: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum), Schema.isPattern(/\S/));
export const ToolParamsSchema = Schema.Struct({
  prompt: boundedString(PROMPT_MAX_LENGTH),
  action: Schema.optional(Schema.Literals(IMAGE_ACTIONS)),
  images: Schema.optional(
    Schema.Array(boundedString(PATH_MAX_LENGTH)).check(Schema.isMaxLength(MAX_IMAGE_INPUTS)),
  ),
  model: Schema.optional(boundedString(MODEL_MAX_LENGTH)),
  imageModel: Schema.optional(ImageModelSchema),
  outputFormat: Schema.optional(ImageOutputFormatSchema),
  save: Schema.optional(ImageSaveModeSchema),
  saveDir: Schema.optional(boundedString(PATH_MAX_LENGTH)),
});
export type ToolParams = typeof ToolParamsSchema.Type;
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
});
export type CodexImageDetails = typeof CodexImageDetailsSchema.Type;

export type ExtractedImageResult = Omit<
  CodexImageResult,
  "prompt" | "savedPath" | "model" | "imageModel" | "action" | "outputFormat"
>;

export class OpenAIImageError extends Schema.TaggedError<OpenAIImageError>()("OpenAIImageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
export const fail = (operation: string, message: string) =>
  new OpenAIImageError({ operation, message });
export const failWith = (operation: string, message: string) => () => fail(operation, message);
