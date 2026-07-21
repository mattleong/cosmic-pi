/** Thin Pi registration adapter for Cosmic UI. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCosmicUiApplication } from "./application.ts";

export default function cosmicUi(pi: ExtensionAPI): void {
  registerCosmicUiApplication(pi);
}
