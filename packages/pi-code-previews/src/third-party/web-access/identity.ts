import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** The adapter's default tool names, in gallery order, and their display labels. */
export const WEB_ACCESS_LABELS = {
  web_enable: "web tools",
  web_search: "web search",
  source_check: "source check",
  fetch_content: "fetch content",
  get_search_content: "stored content",
} as const;
export type WebAccessTool = keyof typeof WEB_ACCESS_LABELS;

export function isWebAccessTool(name: string): name is WebAccessTool {
  return Object.hasOwn(WEB_ACCESS_LABELS, name);
}

export const WEB_ACCESS_TOOLS: readonly WebAccessTool[] = Object.freeze(
  Object.keys(WEB_ACCESS_LABELS).filter(isWebAccessTool),
);

/** Exact public npm package identity and known entrypoints; never basename/suffix discovery. */
export function admitsWebAccessSource(tool: ToolInfo): boolean {
  const { sourceInfo } = tool;
  if (
    !isWebAccessTool(tool.name) ||
    sourceInfo.origin !== "package" ||
    !/^npm:pi-web-access(?:@[^@:\s/\\]+)?$/.test(sourceInfo.source) ||
    !sourceInfo.baseDir
  )
    return false;
  const root = sourceInfo.baseDir.replaceAll("\\", "/").replace(/\/$/, "");
  const path = sourceInfo.path.replaceAll("\\", "/");
  return path === `${root}/dist/index.js` || path === `${root}/index.ts`;
}
