export const FAST_SERVICE_TIER = "priority";

export const SUPPORTED_FAST_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
] as const;

const SUPPORTED_FAST_MODEL_SET = new Set<string>(SUPPORTED_FAST_MODELS);

export function fastModelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function supportsFastModel(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  return Boolean(provider && model && SUPPORTED_FAST_MODEL_SET.has(fastModelKey(provider, model)));
}
