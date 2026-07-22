import { defaultCodePreviewSettings } from "./defaults";
import type { CodePreviewSettings } from "./schema";

function freezeSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return Object.freeze({
    ...settings,
    tools: Object.freeze([...settings.tools]),
  }) as CodePreviewSettings;
}

let projected: CodePreviewSettings | undefined;

function publishSettingsProjection(settings: CodePreviewSettings): CodePreviewSettings {
  projected = freezeSettings(settings);
  return projected;
}

function initializeSettingsProjection(settings: CodePreviewSettings): void {
  projected ??= freezeSettings(settings);
}

initializeSettingsProjection(defaultCodePreviewSettings);

/** Live immutable synchronous projection. Imports observe replacement atomically. */
export let codePreviewSettings: CodePreviewSettings = defaultCodePreviewSettings;

export function setCodePreviewSettings(next: CodePreviewSettings): void {
  codePreviewSettings = publishSettingsProjection(next);
}

export function cloneCodePreviewSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return { ...settings, tools: [...settings.tools] };
}
