import type { CodexImageDetails } from "./types.ts";

/**
 * The agent-facing text attached beside a generated image. Renderers compare against it to tell
 * whether a result's text says anything its structured details do not.
 */
export const imageResultText = (result: CodexImageDetails): string => {
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
