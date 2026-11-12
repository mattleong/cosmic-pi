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
  argumentFailureIssue,
  isRejectedEmptyCall,
  receivedArguments,
} from "./src/tools/argument-failure";
export {
  exitIssueMessage,
  exitStatusMeaning,
  outputFailureLine,
  OUTPUT_FAILURE_LINE_LIMIT,
} from "./src/tools/process-failure";
export { renderCompactIssues, repeatsIssueMessage } from "./src/preview/compact-issues";
export { previewIssuesSlot } from "./src/preview/preview-issues";
export {
  hiddenPreviewExpandHintForShell,
  renderHiddenPreviewExpandHint,
} from "./src/preview/bordered-tool-call";
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
  type CompactDetail,
  type CompactSummary,
  type CompactSummaryProvider,
} from "./src/tools/compact-summary";

export { selectCompactChildren, renderCompactChildren } from "./src/preview/compact-children";
export { compactPlainText, renderCompactRow } from "./src/preview/compact-row";
export { endElide, middleElide } from "./src/preview/compact-header";
export { headingCounter, headingShowedSubject } from "./src/preview/heading-coverage";
export { headingValue, HEADING_VALUE_COLUMNS } from "./src/preview/heading-value";
export { previewHeadingText, wrapPreviewHeading } from "./src/preview/heading-wrap";
export { previewMessageHeading, type PreviewMessageHeading } from "./src/preview/preview-heading";
export { expandedArguments, expandedSection } from "./src/preview/expanded-section";
export {
  expandedAuthoredText,
  expandedBody,
  expandedDetails,
  expandedFields,
  expandedText,
  type ExpandedField,
  type ExpandedLine,
  type ExpandedTone,
} from "./src/preview/expanded-body";
export {
  authoredText,
  authoredTextLines,
  COLLAPSED_AUTHORED_TEXT_ROWS,
  type AuthoredTextColor,
  type AuthoredTextOptions,
  type AuthoredTextTheme,
} from "./src/preview/authored-text";
export { escapeControlChars } from "./src/shared/terminal-text";
export { captureCodePreviewPresentationPolicy } from "./src/preview/presentation-policy";
export {
  withCodePreviewMessageShell,
  type CodePreviewMessage,
  type CodePreviewMessageOptions,
  type CodePreviewMessagePresenter,
  type CodePreviewMessageRenderer,
} from "./src/preview/message-shell";
