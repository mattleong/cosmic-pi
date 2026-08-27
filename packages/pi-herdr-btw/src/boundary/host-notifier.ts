import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyAtHostBoundary } from "pi-cosmic-core";

export const notifyHerdrBtw = (
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error",
): void => {
  try {
    if (ctx.hasUI) notifyAtHostBoundary(ctx, message, level);
  } catch {
    // A stale or shutting-down Pi host cannot own command completion.
  }
};
