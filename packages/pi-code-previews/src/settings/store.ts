import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  hasCodePreviewSessionCapability,
  runCodePreviewSessionEffect,
} from "../session-capability";
import { defaultCodePreviewSettings } from "./defaults";
import { runOneShotSettingsEffect } from "../boundary/settings-one-shot";
import { CodePreviewSettingsService, settingsSaveContextProjection } from "./service";
import {
  defaultSettingsSaveContext,
  getSettingsPathFrom,
  type LoadSettingsOptions,
  type SettingsSaveContext,
} from "./store-core";
import type { CodePreviewSettings } from "./types";

export * from "./store-core";

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
