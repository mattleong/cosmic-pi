/**
 * Syntax-highlighted code previews for pi.
 *
 * The package root is the public API for package authors. Keep extension internals under `src/`
 * and expose only stable helpers/types from this file.
 */
export { codePreviews as default } from "./src/extension";

/** Load persisted code-preview settings into the runtime singleton and return a defensive copy. */
export { loadCodePreviewSettings } from "./src/config/store";

/** Decorate a package-owned tool, capturing the current visual shell mode at wrapping time. */
export { withCodePreviewShell, type CodePreviewShellOptions } from "./src/tools/cooperative-tools";

/** Compose into the registering extension's session Layer, then pass schedule to its shell. */
export {
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
} from "./src/application/scheduler";

/** Reuse the canonical standalone-call icon in compound or nested tool renderers. */
export { getCodePreviewToolIcon } from "./src/tools/presentation";

/** Newline-joined text parts of a tool result's content. */
export { getTextContent } from "./src/tools/data/results";

/** Public settings types used by package authors integrating with pi-code-previews. */
export type {
  CodePreviewSettings,
  ToolCallBackgroundMode,
  ToolCallCollapsedStyle,
} from "./src/config/schema";

/** Argument-only builtin targets for compound/nested call previews. */
export {
  describeBuiltinCompactSubject,
  type BuiltinCompactTool,
} from "./src/tools/builtin-subject";

/** One issue shape for every compact card: a human message plus expanded-only detail. */
export {
  compactIssueSeverity,
  mergeCompactIssues,
  type CompactIssue,
  type CompactIssueSeverity,
} from "./src/tools/compact-issues";
export { failureMessage, firstLineMessage, isAgentGuidance } from "./src/tools/issue-message";
export { renderCompactIssues } from "./src/preview/compact-issues";
export { createBoundedCompactIssuesSchema } from "./src/tools/compact-issues-schema";
export { planCompactPresentation } from "./src/tools/compact-presentation";

/** Semantic compact summaries for cooperating tools. */
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
export { renderCompactRow } from "./src/preview/compact-row";
export { expandedSection } from "./src/preview/expanded-section";
export { captureCodePreviewPresentationPolicy } from "./src/preview/presentation-policy";
