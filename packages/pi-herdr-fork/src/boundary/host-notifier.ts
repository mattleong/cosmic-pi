import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const notifyHerdrFork = (
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error",
): void => {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // A stale or shutting-down Pi host cannot own command completion.
  }
};
