import type { CodePreviewSettings } from "../config/schema";
import { codePreviewSettings } from "../config/state";

/** Detached, no-I/O snapshot of the currently published presentation settings. */
export function captureCodePreviewPresentationPolicy(): Pick<
  CodePreviewSettings,
  "toolCallTiming" | "toolCallCollapsedStyle"
> {
  return {
    toolCallTiming: codePreviewSettings.toolCallTiming,
    toolCallCollapsedStyle: codePreviewSettings.toolCallCollapsedStyle,
  };
}
