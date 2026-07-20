import { runSerializedPlatformEffect } from "../boundary/platform";
import { cloneCodePreviewSettings, type CodePreviewSettings } from "./index";
import { saveSettingsToDisk, settingsBoundaryLock, waitForSettingsSavesEffect } from "./store";

export function queueSettingsSave(settings: CodePreviewSettings): Promise<void> {
  return saveSettingsToDisk(cloneCodePreviewSettings(settings));
}

export function flushSettingsSaveQueue(): Promise<void> {
  return runSerializedPlatformEffect(settingsBoundaryLock, waitForSettingsSavesEffect);
}

export function formatSettingsSaveError(error: unknown): string {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Unknown error.";
  return `Failed to save code preview settings: ${message}`;
}
