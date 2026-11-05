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

/** `cwd`, when given, is the session directory the message renderer shows saved paths against. */
export function registerImagePresentation(
  scheduleAnimation?: CompactAnimationScheduler,
  cwd?: string,
) {
  const messageRenderer = createOpenAIImageMessageRenderer();
  if (cwd !== undefined) messageRenderer.noteCwd({ cwd });
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
