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
import {
  failureMessage,
  invokeHostCallback,
  notifyAtHostBoundary,
  type ExtensionCommand,
} from "pi-cosmic-core";
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
import { sessionNotStarted } from "../usage/controller.ts";
import { IMAGE_OUTPUT_SCHEMA, imageDetails, imageToolResult } from "./tool-result.ts";
import { TOOL_PARAMS, type CodexImageDetails, type ToolParams } from "./types.ts";

export const OPENAI_IMAGE_TOOL = "openai_image";
const OPENAI_IMAGE_MESSAGE = "openai-image";

/** Records the working directory that image messages display saved paths against. */
export type NoteImageCwd = (source: { readonly cwd: string }) => void;

/**
 * Registers the `/openai image` message renderer once, at factory time: Pi draws history before
 * session_start. Presentation policy is read per render. Returns the display-cwd updater.
 */
export function registerOpenAIImageMessageRenderer(pi: ExtensionAPI): NoteImageCwd {
  // Messages carry no working directory; saved paths display relative to the latest one seen.
  let cwd = "";
  pi.registerMessageRenderer<CodexImageDetails>(OPENAI_IMAGE_MESSAGE, (message, options, theme) =>
    renderImageMessage(
      message,
      {
        expanded: options.expanded,
        compact: captureCodePreviewPresentationPolicy().toolCallCollapsedStyle === "compact",
        cwd,
      },
      theme,
    ),
  );
  return (source) => {
    cwd = invokeHostCallback(() => source.cwd, cwd);
  };
}

export interface OpenAIImageRegistrationOptions {
  /** The factory-time message renderer's cwd updater; only current calls reach it. */
  readonly noteCwd: NoteImageCwd;
  readonly scheduleAnimation?: CompactAnimationScheduler | undefined;
  readonly isCurrent?: () => boolean;
  /** Wraps the tool after trusted preview settings load, e.g. a cold-history replay shell. */
  readonly shell?: typeof withCodePreviewShell;
}

/** Registers the image tool, and adds or replaces `/openai image`. */
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
  const generateEffect = (params: ToolParams) =>
    OpenAIImageService.use((service) => service.generate(params));
  const retired = () => Promise.reject(sessionNotStarted());
  command.add({
    name: "image",
    arguments: "<prompt>",
    description: "Generate an image with OpenAI Codex image generation",
    handler: (args, ctx) => {
      // A retained command closure belongs to its registration's session, not the live slot.
      if (!isCurrent()) return Promise.resolve();
      const prompt = args.trim();
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
              // Promise delivery has a separate microtask: recheck immediately beside send.
              if (!canDeliver()) return;
              pi.sendMessage({
                customType: OPENAI_IMAGE_MESSAGE,
                content: [
                  { type: "text", text: imageResultText(image) },
                  { type: "image", data: image.data, mimeType: image.mimeType },
                ],
                display: true,
                details: imageDetails(image),
              });
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
    outputSchema: IMAGE_OUTPUT_SCHEMA,
    renderCall: (args, theme, context) => renderImageCall(args, theme, context),
    renderResult: (result, options, theme, context) =>
      renderImageResult(result, options, theme, context),
    execute(_id, params, signal, onUpdate, ctx) {
      if (!isCurrent()) return retired();
      noteCwd(ctx);
      const projectionText = `Requesting OpenAI image_generation via ${ctx.model?.id ?? "configured model"}…`;
      onUpdate?.({ content: [{ type: "text", text: projectionText }], details: undefined });
      // Progress is a host callback: recheck authority before the context write.
      if (!isCurrent()) return retired();
      updateContext(ctx);
      return run(generateEffect(params), signal).then(imageToolResult);
    },
  });
  pi.registerTool(
    shell(tool, {
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
