import * as Schema from "effect/Schema";
import {
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  type ImageOutputFormat,
  type ImageSaveMode,
} from "../config/schema.ts";

export { IMAGE_OUTPUT_FORMATS, IMAGE_SAVE_MODES, type ImageOutputFormat, type ImageSaveMode };

export const OPENAI_IMAGE_TOOL = "openai_image";
export const OPENAI_IMAGE_COMMAND = "openai-image";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_TIMEOUT_MS = 180_000;
export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_INPUTS = 5;
export const MAX_TOTAL_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_RESPONSE_BYTES = 100 * 1024 * 1024;
export const MAX_SSE_EVENT_CHARS = 80 * 1024 * 1024;
export const MAX_GENERATED_IMAGE_BYTES = 60 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_FORMATS = new Set(["png", "jpeg", "jpg", "webp", "gif"]);
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
    model: boundedJsonString(MODEL_MAX_LENGTH),
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
export const TOOL_PARAM_KEYS = new Set(Object.keys(TOOL_PARAMS.properties));
export type ToolParams = typeof ToolParamsSchema.Type;
export type ImageInput = {
  readonly path: string;
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

export class OpenAIImageError extends Schema.TaggedErrorClass<OpenAIImageError>()(
  "OpenAIImageError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}
export const fail = (operation: string, message: string) =>
  new OpenAIImageError({ operation, message });
