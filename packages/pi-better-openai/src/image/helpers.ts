import { isStringValue } from "pi-cosmic-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { isStrictlyInsidePathWith } from "pi-cosmic-core";
import type { ResolvedConfig } from "../config/index.ts";
import { type ImageRequest } from "./protocol.ts";
import {
  MAX_GENERATED_IMAGE_BYTES,
  type CodexImageResult,
  type ExtractedImageResult,
  type ImageInput,
  type ImageOutputFormat,
  type ToolParams,
} from "./types.ts";

export function resolveModel(
  params: Pick<ToolParams, "model">,
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
): string {
  const model = params.model?.trim();
  if (model) return model.includes("/") ? model.split("/").pop() || model : model;
  return ctx.model?.provider === "openai-codex"
    ? (ctx.model.id ?? cfg.image.defaultModel)
    : cfg.image.defaultModel;
}
export function resolveImageConfig(cfg: ResolvedConfig, params: ToolParams) {
  return {
    action: params.action ?? "auto",
    outputFormat: params.outputFormat ?? cfg.image.outputFormat,
    save: params.save ?? cfg.image.defaultSave,
  };
}
export function imageMimeType(path: string, outputFormat?: string): string {
  if (outputFormat === "jpeg" || outputFormat === "jpg") return "image/jpeg";
  if (outputFormat === "webp") return "image/webp";
  if (outputFormat === "gif") return "image/gif";
  if (outputFormat === "png") return "image/png";
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}
export const extensionForFormat = (format: ImageOutputFormat) =>
  format === "jpeg" ? "jpg" : format;
export const isInside = (path: Path.Path, root: string, child: string) =>
  isStrictlyInsidePathWith(path, path.resolve(root), path.resolve(child));
export function dataUrlParts(value: string, expectedMimeType: string) {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(value);
  return { data: (match?.[1] ?? value).trim(), mimeType: expectedMimeType };
}
export function decodeBase64(value: string): Uint8Array | undefined {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= MAX_GENERATED_IMAGE_BYTES ? bytes : undefined;
}
function asImageResultItem<ValueInput>(
  value: ValueInput,
):
  | { id?: string; status?: string; revised_prompt?: string; result?: string; b64_json?: string }
  | undefined {
  if (!Predicate.isObject(value) || value.type !== "image_generation_call") return undefined;
  return value;
}
export function extractImageFromEvent<EventInput>(
  event: EventInput,
  fallbackMimeType: string,
  fallbackId: string,
): ExtractedImageResult | undefined {
  if (!Predicate.isObject(event)) return undefined;
  const item = asImageResultItem(event.item) ?? asImageResultItem(event);
  if (item) {
    const raw =
      isStringValue(item.result) && item.result.trim()
        ? item.result
        : isStringValue(item.b64_json)
          ? item.b64_json
          : undefined;
    if (!raw) return undefined;
    const parts = dataUrlParts(raw, fallbackMimeType);
    return (() => {
      const objectPart3492_0 = {
        id: isStringValue(item.id) ? item.id : fallbackId,
        status: isStringValue(item.status) ? item.status : "completed",
      };
      const objectPart3492_1 = isStringValue(item.revised_prompt)
        ? { ...objectPart3492_0, revisedPrompt: item.revised_prompt }
        : objectPart3492_0;
      const objectPart3492_2 = { ...objectPart3492_1, ...parts };
      return objectPart3492_2;
    })();
  }
  const partial = isStringValue(event.partial_image_b64)
    ? event.partial_image_b64
    : isStringValue(event.b64_json)
      ? event.b64_json
      : undefined;
  if (partial?.trim())
    return { id: fallbackId, status: "partial", ...dataUrlParts(partial, fallbackMimeType) };
  return undefined;
}
export function buildRequest(
  params: ToolParams,
  model: string,
  cfg: ResolvedConfig,
  images: readonly ImageInput[],
): ImageRequest {
  const { action, outputFormat } = resolveImageConfig(cfg, params);
  const content: Array<
    | { readonly type: "input_text"; readonly text: string }
    | {
        readonly type: "input_image";
        readonly detail: "auto";
        readonly image_url: string;
      }
  > = [{ type: "input_text", text: params.prompt }];
  for (const image of images)
    content.push({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  const tool: ImageRequest["tools"][number] =
    action === "auto"
      ? { type: "image_generation", output_format: outputFormat }
      : { type: "image_generation", output_format: outputFormat, action };
  return {
    model,
    instructions: "",
    input: [{ role: "user", content }],
    tools: [tool],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
    client_metadata: { "x-codex-installation-id": "pi-better-openai" },
  } satisfies ImageRequest;
}

export function resultText(result: CodexImageResult): string {
  const parts = [
    `Generated image using OpenAI image_generation tool via openai-codex/${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
  ];
  if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.savedPath) parts.push(`Saved: ${result.savedPath}`);
  return parts.join("\n");
}

export const isImageContent = <Value>(
  value: Value,
): value is Value & { type: "image"; data: string; mimeType: string } =>
  Predicate.isObject(value) &&
  value.type === "image" &&
  isStringValue(value.data) &&
  isStringValue(value.mimeType);
