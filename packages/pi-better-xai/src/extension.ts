/** Thin Pi registration adapter for Better xAI. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBetterXaiApplication } from "./application.ts";

export default function betterXai(pi: ExtensionAPI): void {
  registerBetterXaiApplication(pi);
}

export { betterXaiWithDependencies, type BetterXaiExtensionDependencies } from "./application.ts";
