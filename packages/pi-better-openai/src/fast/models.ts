export const FAST_SERVICE_TIER = "priority";

export function supportsFastModel(
  provider: string | undefined,
  model: string | undefined,
): boolean {
  return Boolean(model && (provider === "openai" || provider === "openai-codex"));
}
