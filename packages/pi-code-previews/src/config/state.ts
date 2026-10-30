import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { freezeSnapshot } from "pi-cosmic-core/projection";
import {
  defaultCodePreviewPerformanceConfig,
  defaultCodePreviewSettings,
  type CodePreviewPerformanceConfig,
} from "./defaults";
import type { SettingsLoadProblem } from "./service";
import {
  TOOL_CALL_BACKGROUND_MODES,
  TOOL_CALL_COLLAPSED_STYLES,
  type CodePreviewSettings,
  type ToolCallBackgroundMode,
  type ToolCallCollapsedStyle,
} from "./schema";

export let codePreviewSettings: CodePreviewSettings = defaultCodePreviewSettings;

/** The appearance every tool row and message in this Pi process shares. */
export interface SharedPresentation {
  readonly toolCallBackground: ToolCallBackgroundMode;
  readonly toolCallCollapsedStyle: ToolCallCollapsedStyle;
}

// Pi loads each extension in its own module graph, and concurrent loads can mix copies of this
// module, so a consumer's renderer may hold a copy no settings load reached. Every load publishes
// the appearance to one process-wide slot that renderers read instead.
declare global {
  // Process-wide; any copy may write it, so readers decode it.
  // oxlint-disable-next-line no-var -- a global declaration requires var
  var piCodePreviewsSharedPresentation: unknown;
}

const SharedPresentationSchema = Schema.Struct({
  toolCallBackground: Schema.Literals(TOOL_CALL_BACKGROUND_MODES),
  toolCallCollapsedStyle: Schema.Literals(TOOL_CALL_COLLAPSED_STYLES),
});
const decodeSharedPresentation = Schema.decodeUnknownOption(SharedPresentationSchema, {
  onExcessProperty: "ignore",
});

export function publishSharedPresentation(settings: SharedPresentation): void {
  globalThis.piCodePreviewsSharedPresentation = Object.freeze({
    toolCallBackground: settings.toolCallBackground,
    toolCallCollapsedStyle: settings.toolCallCollapsedStyle,
  });
}

/** The process-wide appearance, or this copy's settings before any load published one. */
export function sharedPresentation(): SharedPresentation {
  return Option.getOrElse(
    decodeSharedPresentation(globalThis.piCodePreviewsSharedPresentation),
    () => codePreviewSettings,
  );
}

export function setCodePreviewSettings(next: CodePreviewSettings): void {
  codePreviewSettings = freezeSnapshot(next);
  publishSharedPresentation(next);
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
