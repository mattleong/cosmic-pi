import { defaultCodePreviewSettings } from "./defaults";
import type { CodePreviewSettings } from "./schema";

function freezeSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return Object.freeze({
    ...settings,
    tools: Object.freeze([...settings.tools]),
  }) as CodePreviewSettings;
}

/** Live immutable synchronous projection. Imports observe replacement atomically. */
export let codePreviewSettings: CodePreviewSettings = defaultCodePreviewSettings;

export function setCodePreviewSettings(next: CodePreviewSettings): void {
  codePreviewSettings = freezeSettings(next);
}

export function cloneCodePreviewSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return { ...settings, tools: [...settings.tools] };
}
