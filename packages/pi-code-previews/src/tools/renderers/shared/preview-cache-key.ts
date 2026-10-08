import type { Theme } from "@earendil-works/pi-coding-agent";
import { hashString } from "../../../shared/helpers";
import { codePreviewSettings } from "../../../config/state";
import { getShikiStatus } from "../../../syntax/render";

let themeCacheIdCounter = 0;
const themeCacheIds = new WeakMap<Theme, number>();

/** Every input a cached preview draws from: source, settings, theme and highlighter status. */
export function previewCacheKey(
  kind: string,
  source: string,
  path: string,
  expanded: boolean,
  theme: Theme,
  collapsedLines: number | "all",
): string {
  const shikiStatus = getShikiStatus();
  return [
    kind,
    path,
    expanded ? "expanded" : "collapsed",
    codePreviewSettings.shikiTheme,
    codePreviewSettings.syntaxHighlighting ? "syntax" : "plain",
    codePreviewSettings.diffIntensity,
    codePreviewSettings.wordEmphasis,
    themeCacheKey(theme),
    source.length,
    hashString(source),
    collapsedLines,
    shikiStatus.initialized ? "shiki-ready" : "shiki-loading",
    shikiStatus.loadedLanguages,
    shikiStatus.pendingLanguages,
    shikiStatus.statusVersion,
  ].join("\0");
}

function themeCacheKey(theme: Theme): string {
  let id = themeCacheIds.get(theme);
  if (id === undefined) {
    id = ++themeCacheIdCounter;
    themeCacheIds.set(theme, id);
  }
  return `${theme.name ?? ""}\0theme:${id}`;
}
