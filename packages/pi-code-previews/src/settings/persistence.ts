import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../session-capability";
import { cloneCodePreviewSettings, type CodePreviewSettings } from "./index";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { CodePreviewSettingsService } from "./service";

export function queueSettingsSave(settings: CodePreviewSettings): Promise<void> {
  const effect = CodePreviewSettingsService.use((service) =>
    service.save(cloneCodePreviewSettings(settings)),
  );
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
}

export function flushSettingsSaveQueue(): Promise<void> {
  const effect = CodePreviewSettingsService.use((service) => service.flush);
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
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
