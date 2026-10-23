import type { CodexImageDetails } from "./types.ts";

export const imageResultText = (result: CodexImageDetails): string => {
  const parts = [
    `Generated image using OpenAI image_generation tool via openai-codex/${result.model}.`,
    `Action: ${result.action}.`,
    `Prompt: ${result.prompt}`,
  ];
  if (result.imageModel) parts.push(`Image model: ${result.imageModel}.`);
  if (result.revisedPrompt) parts.push(`Revised prompt: ${result.revisedPrompt}`);
  if (result.savedPath) parts.push(`Saved: ${result.savedPath}`);
  if (result.note) parts.push(`Note: ${result.note}.`);
  return parts.join("\n");
};
