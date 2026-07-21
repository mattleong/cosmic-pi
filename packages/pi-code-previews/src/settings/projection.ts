import type { CodePreviewSettings } from "./schema";

function freezeSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return Object.freeze({
    ...settings,
    tools: Object.freeze([...settings.tools]),
  }) as CodePreviewSettings;
}

let current: CodePreviewSettings;

export function publishSettingsProjection(settings: CodePreviewSettings): CodePreviewSettings {
  current = freezeSettings(settings);
  return current;
}

export function initializeSettingsProjection(settings: CodePreviewSettings): void {
  current ??= freezeSettings(settings);
}
