import * as Effect from "effect/Effect";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../session-capability";
import { cloneCodePreviewSettings, type CodePreviewSettings } from "./index";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { CodePreviewSettingsService } from "./service";
import { compatibilitySettingsLoadOptions } from "./store";

export function queueSettingsSave(settings: CodePreviewSettings): Promise<void> {
  const next = cloneCodePreviewSettings(settings);
  const save = CodePreviewSettingsService.use((service) => service.save(next));
  if (hasCodePreviewSessionCapability()) return runCodePreviewSessionEffect(save);

  // A one-shot runtime cannot retain service state. Rehydrate its authoritative state from the
  // last compatibility load inputs, then save within that same service instance.
  const saveAfterLoad = CodePreviewSettingsService.use((service) =>
    service
      .loadFromDisk(compatibilitySettingsLoadOptions())
      .pipe(Effect.andThen(service.save(next))),
  );
  return runOneShotSettingsEffect(saveAfterLoad);
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
