import * as Schema from "effect/Schema";
import {
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  type ImageOutputFormat,
  type ImageSaveMode,
} from "../config/schema.ts";

export { IMAGE_OUTPUT_FORMATS, IMAGE_SAVE_MODES, type ImageOutputFormat, type ImageSaveMode };

export const MAX_IMAGE_INPUTS = 5;
export const IMAGE_ACTIONS = ["auto", "generate", "edit"] as const;
export type ImageAction = (typeof IMAGE_ACTIONS)[number];

const NON_WHITESPACE_PATTERN = "\\S";
const PROMPT_MAX_LENGTH = 32_768;
const PATH_MAX_LENGTH = 4_096;
const MODEL_MAX_LENGTH = 256;
const boundedJsonString = (maximum: number) => ({
  type: "string" as const,
  minLength: 1,
  maxLength: maximum,
  pattern: NON_WHITESPACE_PATTERN,
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
        "Mainline Codex model override, for example openai-codex/gpt-5.5. The hosted image model is GPT Image 2.5 Sunburst, not this field.",
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
  outputFormat: Schema.optional(Schema.Literals(IMAGE_OUTPUT_FORMATS)),
  save: Schema.optional(Schema.Literals(IMAGE_SAVE_MODES)),
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
  action: ImageAction;
  outputFormat: ImageOutputFormat;
};
export type ExtractedImageResult = Omit<
  CodexImageResult,
  "prompt" | "savedPath" | "model" | "action" | "outputFormat"
>;

export class OpenAIImageError extends Schema.TaggedError<OpenAIImageError>()("OpenAIImageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
export const fail = (operation: string, message: string) =>
  new OpenAIImageError({ operation, message });
