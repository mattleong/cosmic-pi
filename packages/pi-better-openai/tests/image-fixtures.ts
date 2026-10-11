import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Container, Image, type Component } from "@earendil-works/pi-tui";
import type { CompactAnimationScheduler } from "pi-code-previews";
import { captureRegistrations } from "pi-code-previews/testing";
import { registerExtensionCommand } from "pi-cosmic-core";
import { expect } from "vitest";
import {
  createOpenAIImageMessageRenderer,
  registerOpenAIImage,
  registerOpenAIImageMessageRenderer,
} from "../src/image/register.ts";

export const pngPart = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
export const textPart = (text: string) => ({ type: "text" as const, text });

export type ImageCustomMessage<Details = unknown> = Parameters<MessageRenderer<Details>>[0];

export const imageMessage = <Details>(
  content: ImageCustomMessage["content"],
  details: Details,
): ImageCustomMessage<Details> => ({
  role: "custom",
  customType: "openai-image",
  content,
  display: true,
  details,
  timestamp: 0,
});

export const countImages = (component: Component): number =>
  component instanceof Image
    ? 1
    : component instanceof Container || component instanceof Box
      ? component.children.reduce((count, child) => count + countImages(child), 0)
      : 0;

export function registerImagePresentation(scheduleAnimation?: CompactAnimationScheduler) {
  const messageRenderer = createOpenAIImageMessageRenderer();
  const { tools, messageRenderers } = captureRegistrations((pi) => {
    const noteCwd = registerOpenAIImageMessageRenderer(pi, messageRenderer);
    registerOpenAIImage(
      pi,
      registerExtensionCommand(pi, { name: "openai", description: "OpenAI" }),
      () => {
        throw new Error("Rendering must not execute");
      },
      () => {
        throw new Error("Rendering must not update context");
      },
      { noteCwd, scheduleAnimation },
    );
  });
  expect(messageRenderers.get("openai-image")).toBe(messageRenderer.render);
  return { tool: tools[0]!, message: messageRenderer.render };
}
