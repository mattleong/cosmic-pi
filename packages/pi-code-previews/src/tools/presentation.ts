import type { Theme } from "@earendil-works/pi-coding-agent";
import { isCodePreviewToolName, type CodePreviewToolName } from "./names";

export const CODE_PREVIEW_TOOL_ICONS = {
  bash: "🔧",
  read: "📖",
  write: "✏️",
  edit: "✂️",
  grep: "🔎",
  find: "🎯",
  ls: "📂",
} as const satisfies Record<CodePreviewToolName, string>;

/** Return the canonical standalone-call icon for a supported built-in tool name. */
export function getCodePreviewToolIcon(tool: string): string | undefined {
  return isCodePreviewToolName(tool) ? CODE_PREVIEW_TOOL_ICONS[tool] : undefined;
}

export function renderCodePreviewToolTitle(tool: CodePreviewToolName, theme: Theme): string {
  return theme.fg("toolTitle", `${CODE_PREVIEW_TOOL_ICONS[tool]} ${theme.bold(tool)}`);
}
