import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  captureCodePreviewPresentationPolicy,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import { failureMessage, invokeHostCallback, notifyAtHostBoundary } from "pi-cosmic-core";
import { containCommandFailure, safeHostSignal } from "../boundary/host-ui.ts";
import { imageCompactSummary, isSignInFailure } from "./compact-summary.ts";
import { renderImageMessage } from "./message.ts";
import {
  renderImageCall,
  renderImageContent,
  renderImageRequest,
  renderImageResult,
} from "./presentation.ts";
import { imageResultText } from "./result-text.ts";
import { OpenAIImageService } from "./service.ts";
import {
  TOOL_PARAMS,
  type CodexImageDetails,
  type CodexImageResult,
  type ToolParams,
} from "./types.ts";

const OPENAI_IMAGE_TOOL = "openai_image";
const OPENAI_IMAGE_COMMAND = "openai-image";

const imageDetails = ({ data: _data, ...details }: CodexImageResult): CodexImageDetails => details;

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
  // Messages carry no working directory; saved paths display relative to the latest one seen.
  let cwd = "";
  const noteCwd = (ctx: ExtensionContext) => {
    cwd = invokeHostCallback(() => ctx.cwd, cwd);
  };
  pi.registerMessageRenderer<CodexImageDetails>("openai-image", (message, options, theme) =>
    renderImageMessage(message, { expanded: options.expanded, compact, cwd }, theme),
  );
  pi.registerCommand(OPENAI_IMAGE_COMMAND, {
    description: "Generate an image with OpenAI Codex image generation",
    handler: (args, ctx) => {
      const prompt = args.trim();
      if (!prompt) {
        notifyAtHostBoundary(ctx, "Usage: /openai-image <prompt>", "warning");
        return Promise.resolve();
      }
      notifyAtHostBoundary(ctx, "Requesting an image from OpenAI…", "info");
      updateContext(ctx);
      noteCwd(ctx);
      const signal = safeHostSignal(ctx);
      const request = containCommandFailure(generateEffect({ prompt }), ctx, {
        failed: (message) =>
          `Couldn't generate the image: ${isSignInFailure(message) ? "sign in with /login openai-codex" : failureMessage(message, "unknown error")}`,
        unexpected: "Couldn't generate the image",
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
                  { type: "text", text: imageResultText(image) },
                  { type: "image", data: image.data, mimeType: image.mimeType },
                ],
                display: true,
                details,
              }),
            )
            .catch(() => {
              notifyAtHostBoundary(ctx, "Couldn't show the generated image", "warning");
            });
        })
        .catch(() => {
          if (!signal?.aborted) notifyAtHostBoundary(ctx, "Couldn't generate the image", "warning");
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
    renderCall: (args, theme, context) => renderImageCall(args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderImageResult(result, options, theme, context),
    execute(_id, params, signal, onUpdate, ctx) {
      noteCwd(ctx);
      const projectionText = `Requesting OpenAI image_generation via ${ctx.model?.id ?? "configured model"}…`;
      onUpdate?.({ content: [{ type: "text", text: projectionText }], details: undefined });
      return generate(params, ctx, signal).then((result) => ({
        content: [
          { type: "text", text: imageResultText(result) },
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
        // The compact heading shows the action; its subject may be clipped, so the prompt stays.
        renderCall: (args, theme) =>
          renderImageRequest(args, theme, { prompt: false, action: true }),
        renderResult: renderImageContent,
      },
      scheduleAnimation,
    }),
  );
}
