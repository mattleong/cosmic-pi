import { codePreviewSettings } from "../config/state";
import { ALL_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "./names";
import { formatToolsSettingValue, getEffectiveCodePreviewToolSet } from "./policy";

export function getEnabledCodePreviewTools(): Set<CodePreviewToolName> {
  return getEffectiveCodePreviewToolSet(codePreviewSettings.tools, codePreviewSettings);
}

export function formatEnabledCodePreviewTools(): string {
  const enabled = getEnabledCodePreviewTools();
  return formatToolsSettingValue(ALL_CODE_PREVIEW_TOOLS.filter((tool) => enabled.has(tool)));
}
