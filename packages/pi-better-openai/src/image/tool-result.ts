import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { toPiToolOutputSchema } from "pi-cosmic-core/schema/tool-output";
import { imageResultText } from "./result-text.ts";
import { CodexImageDetailsSchema, type CodexImageDetails, type CodexImageResult } from "./types.ts";

// The structured result carries the details record with its MIME type inside `image`.
const { mimeType: _mimeType, ...detailFields } = CodexImageDetailsSchema.fields;
const ImageToolResultSchema = Schema.Struct({
  contract: Schema.Literal("pi-better-openai/image"),
  version: Schema.Literal(1),
  tool: Schema.Literal("openai_image"),
  ...detailFields,
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

export const imageDetails = ({ data: _data, ...details }: CodexImageResult): CodexImageDetails =>
  details;

const structuredImageResult = (result: CodexImageResult): Schema.Json | undefined => {
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
    ...(result.note !== undefined && { note: result.note }),
    image: { type: "image", data: result.data, mimeType: result.mimeType },
  });
  return Exit.isSuccess(encoded) ? encoded.value : undefined;
};

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
