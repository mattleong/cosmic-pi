import { codePreviewSettings } from "../config/state";
import type { CodePreviewToolName } from "./names";
import { getEffectiveCodePreviewToolSet } from "./policy";

export function getEnabledCodePreviewTools(): Set<CodePreviewToolName> {
  return getEffectiveCodePreviewToolSet(codePreviewSettings.tools, codePreviewSettings);
}
