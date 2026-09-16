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

export { isCompactAttention } from "./src/tools/compact-summary";

/** Semantic compact summaries for cooperating tools. */
export type {
  CompactAnimationScheduler,
  CompactPhase,
  CompactOutcome,
  CompactNotice,
  CompactChild,
  CompactSummary,
  CompactSummaryProvider,
} from "./src/tools/compact-summary";

export {
  projectBuiltinCompactSummary,
  type BuiltinCompactPolicy,
  type BuiltinBeforeWrite,
  type BuiltinCompactProjectionInput,
} from "./src/tools/builtin-projection";
export { captureBuiltinCompactPolicy } from "./src/tools/builtin-compact-summary";

export { selectCompactChildren } from "./src/preview/compact-children";
