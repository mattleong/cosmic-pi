import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { withCodePreviewShell } from "pi-code-previews";
import { sanitizeDiagnosticError } from "pi-cosmic-core";
import { ignoreHostUi, safeHostSignal, safeHostUi } from "../boundary/host-ui.ts";
import { OpenAIImageService } from "./service.ts";
import { TOOL_PARAMS, type CodexImageResult, type ToolParams } from "./types.ts";

const OPENAI_IMAGE_TOOL = "openai_image";
const OPENAI_IMAGE_COMMAND = "openai-image";

type CodexImageDetails = Omit<CodexImageResult, "data">;

const imageDetails = ({ data: _data, ...details }: CodexImageResult): CodexImageDetails => details;

const resultText = (result: CodexImageDetails): string => {
  const parts = [
    `Generated image using OpenAI image_generation tool via openai-codex/${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
  ];
  if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.savedPath) parts.push(`Saved: ${result.savedPath}`);
  return parts.join("\n");
};

const isOptionalString = <Value>(value: Value): value is Value & (string | undefined) =>
  value === undefined || Predicate.isString(value);

const isCodexImageDetails = <Value>(value: Value): value is Value & CodexImageDetails =>
  Predicate.isObject(value) &&
  Predicate.isString(value.id) &&
  Predicate.isString(value.status) &&
  Predicate.isString(value.prompt) &&
  isOptionalString(value.revisedPrompt) &&
  Predicate.isString(value.mimeType) &&
  isOptionalString(value.savedPath) &&
  Predicate.isString(value.model) &&
  Predicate.isString(value.action) &&
  Predicate.isString(value.outputFormat);

const isLegacyCodexImageResult = <Value>(value: Value): value is Value & CodexImageResult =>
  isCodexImageDetails(value) &&
  Predicate.hasProperty(value, "data") &&
  Predicate.isString(value.data);

const isImageContent = <Value>(
  value: Value,
): value is Value & { type: "image"; data: string; mimeType: string } =>
  Predicate.isObject(value) &&
  value.type === "image" &&
  Predicate.isString(value.data) &&
  Predicate.isString(value.mimeType);

export function registerOpenAIImage(
  pi: ExtensionAPI,
  run: <A, E>(effect: Effect.Effect<A, E, OpenAIImageService>, signal?: AbortSignal) => Promise<A>,
  updateContext: (ctx: ExtensionContext) => void,
) {
  const generateEffect = (params: ToolParams) =>
    OpenAIImageService.use((service) => service.generate(params));
  const generate = (params: ToolParams, ctx: ExtensionContext, signal?: AbortSignal) => {
    updateContext(ctx);
    return run(generateEffect(params), signal);
  };
  pi.registerMessageRenderer<CodexImageDetails>("openai-image", (message, _options, theme) => {
    const details = isCodexImageDetails(message.details) ? message.details : undefined;
    const text = details
      ? resultText(details)
      : Predicate.isString(message.content)
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const contentImage = Array.isArray(message.content)
      ? message.content.find(isImageContent)
      : undefined;
    let image: { data: string; mimeType: string; savedPath?: string } | undefined;
    if (contentImage)
      image = details?.savedPath ? { ...contentImage, savedPath: details.savedPath } : contentImage;
    else if (isLegacyCodexImageResult(message.details))
      image = message.details.savedPath
        ? {
            data: message.details.data,
            mimeType: message.details.mimeType,
            savedPath: message.details.savedPath,
          }
        : { data: message.details.data, mimeType: message.details.mimeType };
    const container = new Container();
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(`${theme.fg("accent", theme.bold("[openai-image]"))}\n\n${text}`, 0, 0));
    if (image)
      box.addChild(
        new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (line) => theme.fg("dim", line) },
          image.savedPath
            ? { maxWidthCells: 80, maxHeightCells: 24, filename: image.savedPath }
            : { maxWidthCells: 80, maxHeightCells: 24 },
        ),
      );
    container.addChild(box);
    return container;
  });
  pi.registerCommand(OPENAI_IMAGE_COMMAND, {
    description: "Generate an image with OpenAI Codex image generation",
    handler: (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        safeHostUi(() => ctx.ui.notify("Usage: /openai-image <prompt>", "error"));
        return Promise.resolve();
      }
      safeHostUi(() => ctx.ui.notify("Requesting OpenAI image...", "info"));
      updateContext(ctx);
      const signal = safeHostSignal(ctx);
      const request = generateEffect({ prompt }).pipe(
        Effect.tapError((error) =>
          ignoreHostUi(() =>
            ctx.ui.notify(
              `OpenAI image generation failed: ${sanitizeDiagnosticError(error.message)}.`,
              "warning",
            ),
          ),
        ),
        Effect.option,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.succeed(Option.none())
            : Effect.logError("Better OpenAI image command raised an unexpected defect.").pipe(
                Effect.andThen(
                  ignoreHostUi(() =>
                    ctx.ui.notify("OpenAI image generation failed unexpectedly.", "warning"),
                  ),
                ),
                Effect.as(Option.none()),
              ),
        ),
      );
      return run(request, signal)
        .then((result) => {
          if (Option.isNone(result)) return undefined;
          const image = result.value;
          const details = imageDetails(image);
          return Promise.resolve()
            .then(() =>
              pi.sendMessage({
                customType: "openai-image",
                content: [
                  { type: "text", text: resultText(image) },
                  { type: "image", data: image.data, mimeType: image.mimeType },
                ],
                display: true,
                details,
              }),
            )
            .catch(() => {
              safeHostUi(() =>
                ctx.ui.notify("Unable to deliver the generated image message.", "warning"),
              );
            });
        })
        .catch(() => {
          if (!signal?.aborted)
            safeHostUi(() =>
              ctx.ui.notify("OpenAI image generation failed unexpectedly.", "warning"),
            );
        });
    },
  });
  const tool = defineTool({
    name: OPENAI_IMAGE_TOOL,
    label: "OpenAI image",
    description:
      "Generate or edit images through OpenAI Codex subscription auth using the hosted image_generation tool.",
    promptSnippet: "Generate or edit raster images via OpenAI Codex subscription auth.",
    promptGuidelines: [
      "Use openai_image when the user asks to generate or edit a raster image.",
      "Pass the user's image prompt verbatim. Do not embellish or rewrite it unless explicitly requested.",
    ],
    parameters: TOOL_PARAMS,
    execute(_id, params, signal, onUpdate, ctx) {
      const projectionText = `Requesting OpenAI image_generation via ${ctx.model?.id ?? "configured model"}...`;
      onUpdate?.({ content: [{ type: "text", text: projectionText }], details: undefined });
      return generate(params, ctx, signal).then((result) => ({
        content: [
          { type: "text", text: resultText(result) },
          { type: "image" as const, data: result.data, mimeType: result.mimeType },
        ],
        details: imageDetails(result),
      }));
    },
  });
  pi.registerTool(withCodePreviewShell(tool));
}
