/** Thin Pi registration adapter for code previews. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodePreviewApplication } from "./application/lifecycle";

export function codePreviews(pi: ExtensionAPI): Promise<void> {
  return registerCodePreviewApplication(pi);
}
