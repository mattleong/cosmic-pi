import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  captureCodePreviewPresentationPolicy,
  getTextContent,
  withCompactIssues,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import { imageMessagePresentation, renderImageContent } from "./presentation.ts";
import { stripTerminalControls } from "pi-cosmic-core";
import { containCommandFailure, safeHostSignal, safeHostUi } from "../boundary/host-ui.ts";
import { imageCompactSummary } from "./compact-summary.ts";
import { OpenAIImageService } from "./service.ts";
import {
  TOOL_PARAMS,
  isCodexImageDetails,
  type CodexImageDetails,
  type CodexImageResult,
  type ToolParams,
} from "./types.ts";

const OPENAI_IMAGE_TOOL = "openai_image";
const OPENAI_IMAGE_COMMAND = "openai-image";

const imageDetails = ({ data: _data, ...details }: CodexImageResult): CodexImageDetails => details;

const resultText = (result: CodexImageDetails): string => {
  const parts = [
    `Generated image using OpenAI image_generation tool via openai-codex/${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
  ];
  if (result.imageModel) parts.push(`Image model: ${result.imageModel}.`);
  if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.savedPath) parts.push(`Saved: ${result.savedPath}`);
  return parts.join("\n");
};

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
  scheduleAnimation?: CompactAnimationScheduler,
) {
  const generateEffect = (params: ToolParams) =>
    OpenAIImageService.use((service) => service.generate(params));
  const generate = (params: ToolParams, ctx: ExtensionContext, signal?: AbortSignal) => {
    updateContext(ctx);
    return run(generateEffect(params), signal);
  };
  const compact = captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact";
  pi.registerMessageRenderer<CodexImageDetails>("openai-image", (message, options, theme) => {
    const details = isCodexImageDetails(message.details) ? message.details : undefined;
    const raw = Predicate.isString(message.content)
      ? message.content
      : getTextContent(message.content);
    const text = details
      ? [resultText(details), ...(raw ? ["Raw result", raw] : [])].join("\n")
      : raw;
    const image =
      (Array.isArray(message.content) ? message.content.find(isImageContent) : undefined) ??
      (isLegacyCodexImageResult(message.details) ? message.details : undefined);
    const container = new Container();
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    const outcome =
      details?.status === "cancelled"
        ? "cancelled"
        : details?.status === "failed"
          ? "error"
          : details?.status === "completed" && image
            ? "success"
            : "uncertain";
    box.addChild(
      compact
        ? imageMessagePresentation(
            details
              ? withCompactIssues(
                  {
                    subject: details.savedPath || details.prompt,
                    action: details.action,
                    outcome,
                    notices:
                      outcome === "error"
                        ? [
                            {
                              code: "image-failed",
                              kind: "error" as const,
                              text: "Image generation failed.",
                              description: "Image generation failed.",
                            },
                          ]
                        : outcome === "uncertain"
                          ? [
                              {
                                code: "image-status",
                                kind: "warning" as const,
                                text: `Image generation is ${details.status}.`,
                                description:
                                  details.status === "completed"
                                    ? "Image generation was reported complete, but no image is attached."
                                    : details.status === "in_progress"
                                      ? "Image generation may still be running."
                                      : "Image generation has no confirmed completion.",
                              },
                            ]
                          : [],
                  },
                  `image:${details.id}`,
                )
              : undefined,
            text,
            options.expanded,
            theme,
          )
        : new Text(`${theme.fg("accent", theme.bold("[openai-image]"))}\n\n${text}`, 0, 0),
    );
    if (image)
      box.addChild(
        new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (line) => theme.fg("dim", line) },
          details?.savedPath
            ? { maxWidthCells: 80, maxHeightCells: 24, filename: details.savedPath }
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
      const request = containCommandFailure(generateEffect({ prompt }), ctx, {
        failed: (message) => `OpenAI image generation failed: ${message}.`,
        unexpected: "OpenAI image generation failed unexpectedly.",
        defect: "Better OpenAI image command raised an unexpected defect.",
      });
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
  pi.registerTool(
    withCodePreviewShell(tool, {
      compactSummary: imageCompactSummary,
      expandedContent: {
        renderCall: (args) => new Text(stripTerminalControls(JSON.stringify(args, null, 2)), 0, 0),
        renderResult: renderImageContent,
      },
      scheduleAnimation,
    }),
  );
}
