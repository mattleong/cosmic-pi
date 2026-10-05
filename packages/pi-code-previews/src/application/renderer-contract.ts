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
  readonly selfShell: true;
  readonly mode?: ToolCallBackgroundMode;
  readonly collapsedStyle?: ToolCallCollapsedStyle;
  readonly enabledTools?: readonly CodePreviewToolName[];
}
