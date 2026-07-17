import type { Theme } from "@earendil-works/pi-coding-agent";
import type { CodePreviewToolName } from "./names";

export const CODE_PREVIEW_TOOL_ICONS = {
  bash: "🔧",
  read: "📖",
  write: "✏️",
  edit: "✂️",
  grep: "🔎",
  find: "🎯",
  ls: "📂",
} as const satisfies Record<CodePreviewToolName, string>;

export function renderCodePreviewToolTitle(tool: CodePreviewToolName, theme: Theme): string {
  return theme.fg("toolTitle", `${CODE_PREVIEW_TOOL_ICONS[tool]} ${theme.bold(tool)}`);
}
