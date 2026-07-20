import type { CodePreviewSettings } from "./schema";

function freezeSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return Object.freeze({
    ...settings,
    tools: Object.freeze([...settings.tools]),
  }) as CodePreviewSettings;
}

let current: CodePreviewSettings;

/** Live immutable projection read only by Pi's synchronous render boundary. */
export function settingsProjection(): CodePreviewSettings {
  return current;
}

export function publishSettingsProjection(settings: CodePreviewSettings): CodePreviewSettings {
  current = freezeSettings(settings);
  return current;
}

export function initializeSettingsProjection(settings: CodePreviewSettings): void {
  current ??= freezeSettings(settings);
}
