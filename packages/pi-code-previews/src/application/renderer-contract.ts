import type { CompactAnimationScheduler } from "../tools/compact-summary";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import type { CodePreviewToolName } from "../tools/names";

/** Captured presentation authority shared by renderer selectors for one session only. */
export interface CodePreviewRendererSession {
  readonly cwd: string;
  readonly scheduleAnimation: CompactAnimationScheduler;
  readonly mode?: ToolCallBackgroundMode;
  readonly collapsedStyle?: ToolCallCollapsedStyle;
  readonly enabledTools: readonly CodePreviewToolName[];
}

/** One row's presentation: rows Pi retained before readiness keep a fixed self shell. */
export interface CodePreviewRendererPresentation extends CodePreviewRendererSession {
  readonly selfShell: boolean;
}

/** Appearance fields native and third-party renderers pass to withCodePreviewRenderers. */
export type CodePreviewRendererAppearance = Pick<
  CodePreviewRendererPresentation,
  "scheduleAnimation" | "mode" | "collapsedStyle"
> & { readonly selfShell?: boolean };
