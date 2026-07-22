import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../application/capability";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { defaultCodePreviewSettings } from "./defaults";
import {
  defaultSettingsSaveContext,
  getSettingsPathFrom,
  type LoadSettingsOptions,
  type SettingsSaveContext,
} from "./document-store";
import type { CodePreviewSettings } from "./schema";
import { CodePreviewSettingsService, settingsSaveContextProjection } from "./service";
import { cloneCodePreviewSettings } from "./state";

export * from "./document-store";
/** Effect settings persistence service — preferred session door. */
export {
  CodePreviewSettingsService,
  settingsSaveContextProjection,
  type CodePreviewSettingsServiceShape,
  type CodePreviewSettingsState,
} from "./service";

let lastCompatibilityLoadOptions: LoadSettingsOptions = {};

/** Plain compatibility input only; authoritative save context remains inside the service. */
export function compatibilitySettingsLoadOptions(): LoadSettingsOptions {
  return { ...lastCompatibilityLoadOptions };
}

/** Synchronous health-panel compatibility; persistence resolves AgentDirectory in Effect. */
export function getSettingsPath(): string {
  return getSettingsPathFrom(getAgentDir());
}

export function getSettingsSaveContext(): SettingsSaveContext {
  const projected = settingsSaveContextProjection();
  return projected ?? defaultSettingsSaveContext(defaultCodePreviewSettings);
}

export function loadSettingsFromDisk(
  options: LoadSettingsOptions = {},
): Promise<CodePreviewSettings | undefined> {
  lastCompatibilityLoadOptions = { ...options };
  const effect = CodePreviewSettingsService.use((service) => service.loadFromDisk(options));
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
}

export function saveSettingsToDisk(
  settings: CodePreviewSettings,
  context?: SettingsSaveContext,
): Promise<void> {
  const effect = CodePreviewSettingsService.use((service) => service.save(settings, context));
  return hasCodePreviewSessionCapability()
    ? runCodePreviewSessionEffect(effect)
    : runOneShotSettingsEffect(effect);
}

/** Queue a settings save through the session runtime, or a one-shot runtime when idle. */
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
