import type { Theme } from "@earendil-works/pi-coding-agent";
import { codePreviewSettings } from "../../../config/state";
import { getShikiStatus } from "../../../syntax/render";

export function previewCacheKey(
  source: readonly string[],
  path: string,
  expanded: boolean,
  theme: Theme,
  collapsedLines: number | "all",
): readonly unknown[] {
  const shikiStatus = getShikiStatus();
  return [
    path,
    expanded,
    theme,
    theme.name,
    codePreviewSettings.shikiTheme,
    codePreviewSettings.syntaxHighlighting,
    codePreviewSettings.diffIntensity,
    codePreviewSettings.wordEmphasis,
    collapsedLines,
    shikiStatus.initialized,
    shikiStatus.loadedLanguages,
    shikiStatus.pendingLanguages,
    shikiStatus.statusVersion,
    ...source,
  ];
}
