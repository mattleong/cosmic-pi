/** Thin Pi registration adapter for Directory Models. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDirectoryModelsApplication } from "./application.ts";

export default function directoryModels(pi: ExtensionAPI): void {
  registerDirectoryModelsApplication(pi);
}
