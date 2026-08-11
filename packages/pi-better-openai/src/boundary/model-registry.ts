import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isUsingOAuthAtHostBoundary } from "pi-cosmic-core";

/** Synchronous renderers treat a hostile model-registry callback as non-OAuth. */
export function isModelUsingOAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): boolean {
  return isUsingOAuthAtHostBoundary(ctx.modelRegistry, model);
}
