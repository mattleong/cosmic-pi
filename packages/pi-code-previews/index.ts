export { codePreviews as default } from "./src/extension";

export { loadCodePreviewSettings } from "./src/config/store";

export {
  withCodePreviewShell,
  withCodePreviewRenderers,
  type CodePreviewShellOptions,
} from "./src/tools/cooperative-tools";

export {
  registerCodePreviewReplay,
  type CodePreviewReplay,
  type CodePreviewReplayOptions,
} from "./src/application/owned-replay";

export {
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
} from "./src/application/scheduler";

export { getCodePreviewToolIcon } from "./src/tools/presentation";

export { getTextContent } from "./src/tools/data/results";

export type {
  CodePreviewSettings,
  ToolCallBackgroundMode,
  ToolCallCollapsedStyle,
} from "./src/config/schema";

export {
  compactIssueSeverity,
  mergeCompactIssues,
  type CompactIssue,
} from "./src/tools/compact-issues";
export {
  exitStatusMeaning,
  outputFailureLine,
  OUTPUT_FAILURE_LINE_LIMIT,
} from "./src/tools/process-failure";
export { renderCompactIssues } from "./src/preview/compact-issues";
export { previewIssuesSlot } from "./src/preview/preview-issues";
export { createBoundedCompactIssuesSchema } from "./src/tools/compact-issues-schema";
export { planCompactPresentation } from "./src/tools/compact-presentation";

export {
  compactStatus,
  resolveCompactSummary,
  type CompactAnimationScheduler,
  type CompactPhase,
  type CompactOutcome,
  type CompactStatus,
  type CompactChild,
  type CompactSummary,
  type CompactSummaryProvider,
} from "./src/tools/compact-summary";

export {
  projectBuiltinCompactSummary,
  type BuiltinCompactPolicy,
  type BuiltinBeforeWrite,
  type BuiltinCompactProjectionInput,
} from "./src/tools/builtin-projection";
export { captureBuiltinCompactPolicy } from "./src/tools/builtin-compact-summary";

export { selectCompactChildren, renderCompactChildren } from "./src/preview/compact-children";
export { compactPlainText, renderCompactRow } from "./src/preview/compact-row";
export { expandedArguments, expandedSection } from "./src/preview/expanded-section";
export { escapeControlChars } from "./src/shared/terminal-text";
export { captureCodePreviewPresentationPolicy } from "./src/preview/presentation-policy";
