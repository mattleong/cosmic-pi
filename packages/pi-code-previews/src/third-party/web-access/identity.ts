import type { PreviewToolInfo } from "../../application/renderer-contract";

export const WEB_ACCESS_TOOLS = [
  "web_enable",
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
] as const;
export type WebAccessTool = (typeof WEB_ACCESS_TOOLS)[number];

export function isWebAccessTool(name: string): name is WebAccessTool {
  return WEB_ACCESS_TOOLS.some((candidate) => candidate === name);
}

/** Exact public npm package identity and known entrypoints; never basename/suffix discovery. */
export function admitsWebAccessSource(tool: PreviewToolInfo): boolean {
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

export const WEB_ACCESS_LABELS = {
  web_enable: "web tools",
  web_search: "web search",
  source_check: "source check",
  fetch_content: "fetch content",
  get_search_content: "stored content",
} satisfies Record<WebAccessTool, string>;
