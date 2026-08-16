import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { withCodePreviewShell } from "pi-code-previews";
import { safeHostSignal, safeHostUi } from "../boundary/host-ui.ts";
import { isImageContent, resultText } from "./helpers.ts";
import { OpenAIImageService } from "./service.ts";
import {
  OPENAI_IMAGE_COMMAND,
  OPENAI_IMAGE_TOOL,
  TOOL_PARAMS,
  type CodexImageResult,
  type ToolParams,
} from "./types.ts";

export function registerOpenAIImage(
  pi: ExtensionAPI,
  run: <A, E>(effect: Effect.Effect<A, E, OpenAIImageService>, signal?: AbortSignal) => Promise<A>,
  updateContext: (ctx: ExtensionContext) => void,
) {
  const generate = (params: ToolParams, ctx: ExtensionContext, signal?: AbortSignal) => {
    updateContext(ctx);
    return run(
      OpenAIImageService.use((service) => service.generate(params)),
      signal,
    );
  };
  pi.registerMessageRenderer<CodexImageResult>("openai-image", (message, _options, theme) => {
    const result = message.details;
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    const text =
      result && Predicate.isObject(result)
        ? resultText(result as CodexImageResult)
        : Predicate.isString(message.content)
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
    let image: { data: string; mimeType: string; savedPath?: string } | undefined;
    if (
      result &&
      Predicate.isObject(result) &&
      Predicate.isString(result.data) &&
      Predicate.isString(result.mimeType)
    )
      image = (() => {
        const objectPart1904_0 = { data: result.data, mimeType: result.mimeType };
        const objectPart1904_1 = Predicate.isString(result.savedPath)
          ? { ...objectPart1904_0, savedPath: result.savedPath }
          : objectPart1904_0;
        return objectPart1904_1;
      })();
    else if (Array.isArray(message.content)) {
      const part = message.content.find(isImageContent);
      if (part) image = part;
    }
    const container = new Container();
    const box = new Box(1, 1, (line) => theme.bg("customMessageBg", line));
    box.addChild(new Text(`${theme.fg("accent", theme.bold("[openai-image]"))}\n\n${text}`, 0, 0));
    if (image)
      box.addChild(
        new Image(
          image.data,
          image.mimeType,
          { fallbackColor: (line) => theme.fg("dim", line) },
          (() => {
            const objectPart2591_0 = { maxWidthCells: 80, maxHeightCells: 24 };
            const objectPart2591_1 = image.savedPath
              ? { ...objectPart2591_0, filename: image.savedPath }
              : objectPart2591_0;
            return objectPart2591_1;
          })(),
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
      return generate({ prompt }, ctx, safeHostSignal(ctx)).then((result) =>
        pi.sendMessage({
          customType: "openai-image",
          content: [
            { type: "text", text: resultText(result) },
            { type: "image", data: result.data, mimeType: result.mimeType },
          ],
          display: true,
          details: result,
        }),
      );
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
        details: result,
      }));
    },
  });
  pi.registerTool(withCodePreviewShell(tool));
}
