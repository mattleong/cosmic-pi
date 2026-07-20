import { defaultCodePreviewSettings } from "./defaults";
import { initializeSettingsProjection, publishSettingsProjection } from "./projection";
import type { CodePreviewSettings } from "./types";

initializeSettingsProjection(defaultCodePreviewSettings);

/** Live immutable synchronous projection. Imports observe replacement atomically. */
export let codePreviewSettings: CodePreviewSettings = defaultCodePreviewSettings;

export function setCodePreviewSettings(next: CodePreviewSettings): void {
  codePreviewSettings = publishSettingsProjection(next);
}

export function cloneCodePreviewSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return { ...settings, tools: [...settings.tools] };
}
