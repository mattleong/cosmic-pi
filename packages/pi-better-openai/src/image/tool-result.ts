import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { toPiToolOutputSchema } from "pi-cosmic-core";
import { ImageOutputFormatSchema } from "../config/schema.ts";
import { imageResultText } from "./result-text.ts";
import { IMAGE_ACTIONS, type CodexImageDetails, type CodexImageResult } from "./types.ts";

/** The native script result; image bytes retain the service's existing validation and limits. */
const ImageToolResultSchema = Schema.Struct({
  contract: Schema.Literal("pi-better-openai/image"),
  version: Schema.Literal(1),
  tool: Schema.Literal("openai_image"),
  id: Schema.String,
  status: Schema.String,
  prompt: Schema.String,
  revisedPrompt: Schema.optional(Schema.String),
  savedPath: Schema.optional(Schema.String),
  model: Schema.String,
  imageModel: Schema.optional(Schema.String),
  action: Schema.Literals(IMAGE_ACTIONS),
  outputFormat: ImageOutputFormatSchema,
  image: Schema.Struct({
    type: Schema.Literal("image"),
    data: Schema.String,
    mimeType: Schema.String,
  }),
});

export const IMAGE_OUTPUT_SCHEMA = toPiToolOutputSchema(ImageToolResultSchema);
const encode = Schema.encodeExit(Schema.toCodecJson(ImageToolResultSchema), {
  errors: "first",
  onExcessProperty: "error",
});

/** Existing renderer/history details remain byte-free, including command messages. */
export const imageDetails = ({ data: _data, ...details }: CodexImageResult): CodexImageDetails =>
  details;

/** Pure projection: no byte decoding, re-encoding, persistence, or prompt rewriting. */
const structuredImageResult = (result: CodexImageResult): Schema.Json | undefined => {
  try {
    const encoded = encode({
      contract: "pi-better-openai/image",
      version: 1,
      tool: "openai_image",
      id: result.id,
      status: result.status,
      prompt: result.prompt,
      ...(result.revisedPrompt !== undefined && { revisedPrompt: result.revisedPrompt }),
      ...(result.savedPath !== undefined && { savedPath: result.savedPath }),
      model: result.model,
      ...(result.imageModel !== undefined && { imageModel: result.imageModel }),
      action: result.action,
      outputFormat: result.outputFormat,
      image: { type: "image", data: result.data, mimeType: result.mimeType },
    });
    return Exit.isSuccess(encoded) ? encoded.value : undefined;
  } catch {
    return undefined;
  }
};

/** A failed invariant cannot undo generation/save or discard its original image and receipt. */
export const imageToolResult = (result: CodexImageResult): AgentToolResult<CodexImageDetails> => {
  const structuredContent = structuredImageResult(result);
  const text = imageResultText(result);
  return {
    content: [
      {
        type: "text",
        text:
          structuredContent === undefined
            ? `Image result is unavailable; generation or saving may have completed\n${text}`
            : text,
      },
      { type: "image", data: result.data, mimeType: result.mimeType },
    ],
    details: imageDetails(result),
    ...(structuredContent === undefined ? { isError: true } : { structuredContent }),
  };
};
