import { freezeSnapshot } from "pi-cosmic-core";
import {
  defaultCodePreviewPerformanceConfig,
  defaultCodePreviewSettings,
  type CodePreviewPerformanceConfig,
} from "./defaults";
import type { SettingsLoadProblem } from "./document-store";
import type { CodePreviewSettings } from "./schema";

/** Live immutable synchronous projection. Imports observe replacement atomically. */
export let codePreviewSettings: CodePreviewSettings = defaultCodePreviewSettings;

export function setCodePreviewSettings(next: CodePreviewSettings): void {
  codePreviewSettings = freezeSnapshot(next);
}

/** Settings files the latest load ignored in whole or in part. */
export let codePreviewSettingsProblems: readonly SettingsLoadProblem[] = [];

export function setCodePreviewSettingsProblems(next: readonly SettingsLoadProblem[]): void {
  codePreviewSettingsProblems = freezeSnapshot([...next]);
}

export function cloneCodePreviewSettings(settings: CodePreviewSettings): CodePreviewSettings {
  return { ...settings, tools: [...settings.tools] };
}

/** Fixed rendering budgets. Only tests and benchmarks replace them. */
export let codePreviewPerformanceConfig: CodePreviewPerformanceConfig =
  defaultCodePreviewPerformanceConfig;

export function setCodePreviewPerformanceConfig(next: CodePreviewPerformanceConfig): void {
  codePreviewPerformanceConfig = Object.freeze({ ...next });
}
