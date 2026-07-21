import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Synchronous renderers treat a hostile model-registry callback as non-OAuth. */
export function isModelUsingOAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): boolean {
  try {
    return ctx.modelRegistry.isUsingOAuth(model);
  } catch {
    return false;
  }
}
