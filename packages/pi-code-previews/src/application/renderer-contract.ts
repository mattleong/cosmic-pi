import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import type { CodePreviewToolName } from "../tools/names";

/** Public host metadata, never an undocumented execution definition from next(). */
export type PreviewToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

/** Captured presentation authority shared by renderer selectors for one session only. */
export interface CodePreviewRendererSession {
  readonly cwd: string;
  readonly scheduleAnimation: CompactAnimationScheduler;
  readonly mode?: ToolCallBackgroundMode;
  readonly collapsedStyle?: ToolCallCollapsedStyle;
  readonly enabledTools?: readonly CodePreviewToolName[];
}

/** One row's presentation: rows Pi retained before readiness keep a fixed self shell. */
export interface CodePreviewRendererPresentation extends CodePreviewRendererSession {
  readonly selfShell: boolean;
}

/** The fields builtin presentation factories pass through to the shared renderer adapter. */
export type CodePreviewRendererAppearance = Pick<
  CodePreviewRendererPresentation,
  "scheduleAnimation" | "selfShell" | "mode" | "collapsedStyle"
>;
