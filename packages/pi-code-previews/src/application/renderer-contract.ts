import type { CompactAnimationScheduler } from "../tools/compact-summary";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import type { CodePreviewToolName } from "../tools/names";

export interface CodePreviewRendererSession {
  readonly cwd: string;
  readonly scheduleAnimation: CompactAnimationScheduler;
  readonly mode?: ToolCallBackgroundMode;
  readonly collapsedStyle?: ToolCallCollapsedStyle;
  readonly enabledTools: readonly CodePreviewToolName[];
}

export interface CodePreviewRendererPresentation extends CodePreviewRendererSession {
  readonly selfShell: boolean;
}

export type CodePreviewRendererAppearance = Pick<
  CodePreviewRendererPresentation,
  "scheduleAnimation" | "mode" | "collapsedStyle"
> & { readonly selfShell?: boolean };
