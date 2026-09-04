export const FAST_SERVICE_TIER = "priority";

export function fastModelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export function supportsFastModel(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  return Boolean(model && (provider === "openai" || provider === "openai-codex"));
}
