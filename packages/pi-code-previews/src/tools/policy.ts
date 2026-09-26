import { ALL_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "./names";
import { requiresBashResultPolicy, type ShellResultPreviewSettings } from "./shell-result-policy";

interface RequiredToolSettings extends ShellResultPreviewSettings {
  readContentPreview: boolean;
  writeContentPreview: boolean;
  editDiffPreview: boolean;
}

export function formatToolsSettingValue(tools: readonly CodePreviewToolName[]): string {
  return tools.length ? tools.join(", ") : "none";
}

export function getEffectiveCodePreviewToolSet(
  configuredTools: Iterable<CodePreviewToolName>,
  settings: RequiredToolSettings,
): Set<CodePreviewToolName> {
  const enabled = new Set(configuredTools);
  if (!settings.readContentPreview) enabled.add("read");
  if (!settings.writeContentPreview) enabled.add("write");
  if (!settings.editDiffPreview) enabled.add("edit");
  if (!settings.grepResultPreview) enabled.add("grep");
  if (!settings.findResultPreview) enabled.add("find");
  if (!settings.lsResultPreview) enabled.add("ls");
  if (requiresBashResultPolicy(settings)) enabled.add("bash");
  return enabled;
}

export function getEffectiveCodePreviewTools(
  configuredTools: Iterable<CodePreviewToolName>,
  settings: RequiredToolSettings,
): CodePreviewToolName[] {
  const enabled = getEffectiveCodePreviewToolSet(configuredTools, settings);
  return ALL_CODE_PREVIEW_TOOLS.filter((tool) => enabled.has(tool));
}
