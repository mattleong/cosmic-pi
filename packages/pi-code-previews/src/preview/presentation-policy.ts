import type { CodePreviewSettings } from "../config/schema";
import { codePreviewSettings } from "../config/state";

export function captureCodePreviewPresentationPolicy(): Pick<
  CodePreviewSettings,
  "toolCallTiming" | "toolCallCollapsedStyle"
> {
  return {
    toolCallTiming: codePreviewSettings.toolCallTiming,
    toolCallCollapsedStyle: codePreviewSettings.toolCallCollapsedStyle,
  };
}
