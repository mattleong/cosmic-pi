import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function notifyDirectoryModelWarning(ctx: ExtensionContext, message: string): void {
  try {
    ctx.ui.notify(message, "warning");
  } catch {
    // Notifications are best effort at the Pi host boundary.
  }
}
