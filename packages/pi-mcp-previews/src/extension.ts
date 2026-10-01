import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mcpPreviewsWithDependencies } from "./application/lifecycle";

export function mcpPreviews(pi: ExtensionAPI): Promise<void> {
  return mcpPreviewsWithDependencies(pi);
}
