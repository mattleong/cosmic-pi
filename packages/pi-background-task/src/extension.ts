/** Thin Pi registration adapter for Background Tasks. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBackgroundTaskApplication } from "./application.ts";

export default function backgroundTask(pi: ExtensionAPI): void {
  registerBackgroundTaskApplication(pi);
}
