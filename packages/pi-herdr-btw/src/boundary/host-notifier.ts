import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback, notifyAtHostBoundary } from "pi-cosmic-core";

export const notifyHerdrBtw = (
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error",
): void => {
  // A stale or shutting-down Pi host cannot own command completion.
  if (invokeHostCallback(() => ctx.hasUI, false)) notifyAtHostBoundary(ctx, message, level);
};
