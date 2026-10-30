import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  withCodePreviewMessageShell,
  withCodePreviewShell,
  type CompactAnimationScheduler,
} from "pi-code-previews";
import { failureMessage } from "pi-cosmic-core/message-text";
import { invokeHostCallback, notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { registerMessageOrigins } from "pi-cosmic-core/host-message-origin";
import { type ExtensionCommand } from "pi-cosmic-core/host-command";
import { containCommandFailure, safeHostSignal } from "../boundary/host-ui.ts";
import { imageCompactSummary, isSignInFailure } from "./compact-summary.ts";
import { presentImageMessage } from "./message.ts";
import {
  renderImageCall,
  renderImageContent,
  renderImageRequest,
  renderImageResult,
} from "./presentation.ts";
import { imageResultText } from "./result-text.ts";
import { OpenAIImageService } from "./service.ts";
import { sessionNotStarted } from "../usage/controller.ts";
import { IMAGE_OUTPUT_SCHEMA, imageDetails, imageToolResult } from "./tool-result.ts";
import { prepareImageArguments, TOOL_PARAMS, type ToolParams } from "./types.ts";

export const OPENAI_IMAGE_TOOL = "openai_image";
const OPENAI_IMAGE_MESSAGE = "openai-image";

export type NoteImageCwd = (source: { readonly cwd: string }) => void;

export interface OpenAIImageMessageRenderer {
  readonly render: MessageRenderer;
  readonly noteCwd: NoteImageCwd;
}

export function createOpenAIImageMessageRenderer(): OpenAIImageMessageRenderer {
  let cwd = "";
  return {
    render: withCodePreviewMessageShell(presentImageMessage(() => cwd)),
    noteCwd: (source) => {
      cwd = invokeHostCallback(() => source.cwd, cwd);
    },
  };
}

export function registerOpenAIImageMessageRenderer(
  pi: ExtensionAPI,
  renderer: OpenAIImageMessageRenderer = createOpenAIImageMessageRenderer(),
): NoteImageCwd {
  pi.registerMessageRenderer(OPENAI_IMAGE_MESSAGE, renderer.render);
  return renderer.noteCwd;
}

/**
 * Marks a delivered image in model requests as the result of the user's own `/openai image`
 * command, whose prompt the user typed, rather than as text the user sent or an automated notice.
 */
export function registerOpenAIImageMessageOrigin(pi: ExtensionAPI): void {
  registerMessageOrigins(pi, {
    extension: "pi-better-openai",
    types: {
      [OPENAI_IMAGE_MESSAGE]: {
        author: "user",
        relays:
          "the image generated for the user's /openai image command and the prompt the user typed",
      },
    },
  });
}

export interface OpenAIImageRegistrationOptions {
  readonly noteCwd: NoteImageCwd;
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly isCurrent?: () => boolean;
  readonly shell?: typeof withCodePreviewShell;
}

const generateEffect = (params: ToolParams) =>
  OpenAIImageService.use((service) => service.generate(params));
const retired = () => Promise.reject(sessionNotStarted());

export function registerOpenAIImage(
  pi: ExtensionAPI,
  command: ExtensionCommand,
  run: <A, E>(effect: Effect.Effect<A, E, OpenAIImageService>, signal?: AbortSignal) => Promise<A>,
  updateContext: (ctx: ExtensionContext) => void,
  {
    noteCwd,
    scheduleAnimation,
    isCurrent = () => true,
    shell = withCodePreviewShell,
  }: OpenAIImageRegistrationOptions,
) {
  command.add({
    name: "image",
    arguments: "<prompt>",
    description: "Generate an image with OpenAI Codex image generation",
    handler: (args, ctx) => {
      if (!isCurrent()) return Promise.resolve();
      const prompt = Str.trim(args);
      if (!prompt) {
        notifyAtHostBoundary(ctx, "Usage: /openai image <prompt>", "warning");
        return Promise.resolve();
      }
      notifyAtHostBoundary(ctx, "Requesting an image from OpenAI…", "info");
      updateContext(ctx);
      noteCwd(ctx);
      const signal = safeHostSignal(ctx);
      const canDeliver = () => isCurrent() && !signal?.aborted;
      const request = containCommandFailure(
        generateEffect({ prompt }),
        ctx,
        {
          failed: (message) =>
            `Couldn't generate the image: ${isSignInFailure(message) ? "sign in with /login openai-codex" : failureMessage(message, "unknown error")}`,
          unexpected: "Couldn't generate the image",
          defect: "Better OpenAI image command raised an unexpected defect.",
        },
        canDeliver,
      );
      return run(request, signal)
        .then((result) => {
          if (Option.isNone(result)) return undefined;
          const image = result.value;
          return Promise.resolve()
            .then(() => {
              if (!canDeliver()) return undefined;
              pi.sendMessage({
                customType: OPENAI_IMAGE_MESSAGE,
                content: [
                  { type: "text", text: imageResultText(image) },
                  { type: "image", data: image.data, mimeType: image.mimeType },
                ],
                display: true,
                details: imageDetails(image),
              });
              return undefined;
            })
            .catch(() => {
              if (canDeliver())
                notifyAtHostBoundary(ctx, "Couldn't show the generated image", "warning");
            });
        })
        .catch(() => {
          if (canDeliver()) notifyAtHostBoundary(ctx, "Couldn't generate the image", "warning");
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
      "Native codemode receives a version-1 pi-better-openai/image result. Show its required image block with image(result.image); send only metadata to text(), never base64 to text(), console, return, or store().",
      "Use save:project and pass the returned savedPath in images for a later edit; edit inputs must remain workspace-contained. save:none skips Better OpenAI file saving, not Pi history.",
    ],
    parameters: TOOL_PARAMS,
    prepareArguments: prepareImageArguments,
    outputSchema: IMAGE_OUTPUT_SCHEMA,
    renderCall: (args, theme, context) => renderImageCall(args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderImageResult(result, options, theme, context),
    execute(_id, params, signal, onUpdate, ctx) {
      if (!isCurrent()) return retired();
      noteCwd(ctx);
      const projectionText = `Requesting OpenAI image_generation via ${ctx.model?.id ?? "configured model"}…`;
      onUpdate?.({ content: [{ type: "text", text: projectionText }], details: undefined });
      if (!isCurrent()) return retired();
      updateContext(ctx);
      return run(generateEffect(params), signal).then(imageToolResult);
    },
  });
  pi.registerTool(
    shell(tool, {
      compactSummary: imageCompactSummary,
      expandedContent: {
        renderCall: (args, theme) =>
          renderImageRequest(args, theme, { prompt: false, action: true }),
        renderResult: renderImageContent,
      },
      scheduleAnimation,
    }),
  );
}
