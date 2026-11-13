import type { CompactAnimationScheduler } from "pi-code-previews";
import { captureRegistrations } from "pi-code-previews/testing";
import { registerExtensionCommand } from "pi-cosmic-core";
import { expect } from "vitest";
import {
  createOpenAIImageMessageRenderer,
  registerOpenAIImage,
  registerOpenAIImageMessageRenderer,
} from "../src/image/register.ts";
import type { CodexImageDetails } from "../src/image/types.ts";

export const pngPart = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
export const textPart = (text: string) => ({ type: "text" as const, text });

/** A completed image's details; tests override the fields they assert on. */
export const imageDetailsFixture = (
  overrides: Partial<CodexImageDetails> = {},
): CodexImageDetails => ({
  id: "image-1",
  status: "completed",
  prompt: "An otter",
  mimeType: pngPart.mimeType,
  model: "model",
  action: "generate",
  outputFormat: "png",
  ...overrides,
});

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
