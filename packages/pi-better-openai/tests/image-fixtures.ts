import { Box, Container, Image, type Component } from "@earendil-works/pi-tui";
import type { CompactAnimationScheduler } from "pi-code-previews";
import { captureRegistrations } from "pi-code-previews/testing";
import { registerExtensionCommand } from "pi-cosmic-core";
import { registerOpenAIImage, registerOpenAIImageMessageRenderer } from "../src/image/register.ts";

export const pngPart = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
export const textPart = (text: string) => ({ type: "text" as const, text });

/** Image components anywhere in a rendered component tree. */
export const countImages = (component: Component): number =>
  component instanceof Image
    ? 1
    : component instanceof Container || component instanceof Box
      ? component.children.reduce((count, child) => count + countImages(child), 0)
      : 0;

/** Registers the image message renderer and tool through a host that must never execute. */
export function registerImagePresentation(scheduleAnimation?: CompactAnimationScheduler) {
  const { tools, messageRenderers } = captureRegistrations((pi) => {
    // The application installs the message renderer at factory time, before any session.
    const noteCwd = registerOpenAIImageMessageRenderer(pi);
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
  return { tool: tools[0]!, message: messageRenderers.get("openai-image")! };
}
