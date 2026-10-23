import { freezeSnapshot } from "pi-cosmic-core/projection";
import {
  defaultCodePreviewPerformanceConfig,
  defaultCodePreviewSettings,
  type CodePreviewPerformanceConfig,
} from "./defaults";
import type { SettingsLoadProblem } from "./service";
import type { CodePreviewSettings } from "./schema";

export let codePreviewSettings: CodePreviewSettings = defaultCodePreviewSettings;

export function setCodePreviewSettings(next: CodePreviewSettings): void {
  codePreviewSettings = freezeSnapshot(next);
}

export let codePreviewSettingsProblems: readonly SettingsLoadProblem[] = [];

export function setCodePreviewSettingsProblems(next: readonly SettingsLoadProblem[]): void {
  codePreviewSettingsProblems = freezeSnapshot([...next]);
}

export function cloneCodePreviewSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return { ...settings, tools: [...settings.tools] };
}

export let codePreviewPerformanceConfig: CodePreviewPerformanceConfig =
  defaultCodePreviewPerformanceConfig;

export function setCodePreviewPerformanceConfig(next: CodePreviewPerformanceConfig): void {
  codePreviewPerformanceConfig = Object.freeze({ ...next });
}
