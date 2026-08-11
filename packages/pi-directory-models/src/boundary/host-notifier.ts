import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { notifyAtHostBoundary } from "pi-cosmic-core";

export function notifyDirectoryModelWarning(ctx: ExtensionContext, message: string): void {
  notifyAtHostBoundary(ctx, message, "warning");
}
