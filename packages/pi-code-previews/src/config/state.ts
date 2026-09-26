import { freezeSnapshot } from "pi-cosmic-core";
import { defaultCodePreviewSettings } from "./defaults";
import type { CodePreviewSettings } from "./schema";

/** Live immutable synchronous projection. Imports observe replacement atomically. */
export let codePreviewSettings: CodePreviewSettings = defaultCodePreviewSettings;

export function setCodePreviewSettings(next: CodePreviewSettings): void {
  codePreviewSettings = freezeSnapshot(next);
}

export function cloneCodePreviewSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return { ...settings, tools: [...settings.tools] };
}
