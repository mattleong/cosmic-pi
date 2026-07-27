import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type HostNotificationLevel = "info" | "warning" | "error";

/**
 * Best-effort Pi notification boundary.
 *
 * Promise-level Pi command recovery must never reject because notification failed.
 */
export function notifyAtHostBoundary(
  ctx: ExtensionContext,
  message: string,
  level: HostNotificationLevel,
): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // A hostile or stale host UI cannot turn recovery into an unhandled callback error.
  }
}
