import type { CodePreviewSettings } from "../config/schema";
import type { CodePreviewToolName } from "./names";

/** A disabled preview setting forces its renderer, which then hides that preview. */
const PREVIEW_SETTINGS = [
  { setting: "readContentPreview", tool: "read" },
  { setting: "writeContentPreview", tool: "write" },
  { setting: "editDiffPreview", tool: "edit" },
  { setting: "grepResultPreview", tool: "grep", commands: ["grep", "egrep", "fgrep"] },
  { setting: "findResultPreview", tool: "find", commands: ["find"] },
  { setting: "lsResultPreview", tool: "ls", commands: ["ls"] },
] as const;
type PreviewSettings = Pick<
  CodePreviewSettings,
  (typeof PREVIEW_SETTINGS)[number]["setting"] | "bashResultPreview"
>;

export function formatToolsSettingValue(tools: readonly CodePreviewToolName[]): string {
  return tools.length ? tools.join(", ") : "none";
}

export function getEffectiveCodePreviewToolSet(
  configuredTools: Iterable<CodePreviewToolName>,
  settings: PreviewSettings,
): Set<CodePreviewToolName> {
  const enabled = new Set(configuredTools);
  for (const { setting, tool } of PREVIEW_SETTINGS) if (!settings[setting]) enabled.add(tool);
  // Bash hides its own result, or a grep, find or ls result whose preview is disabled.
  const shellHidden = PREVIEW_SETTINGS.some(
    (entry) => "commands" in entry && !settings[entry.setting],
  );
  if (!settings.bashResultPreview || shellHidden) enabled.add("bash");
  return enabled;
}

/** Whether bash hides the result of a command whose own builtin preview is disabled. */
export function shouldHideShellResultByCommand(
  shellCommand: string | undefined,
  settings: PreviewSettings,
): boolean {
  if (!settings.bashResultPreview) return true;
  if (!shellCommand) return false;
  const policy = PREVIEW_SETTINGS.find(
    (entry) => "commands" in entry && entry.commands.some((command) => command === shellCommand),
  );
  return policy ? !settings[policy.setting] : false;
}
