import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

export const WEB_ACCESS_LABELS = {
  web_enable: "web tools",
  web_search: "web search",
  source_check: "source check",
  fetch_content: "fetch content",
  get_search_content: "stored content",
} as const;
export type WebAccessTool = keyof typeof WEB_ACCESS_LABELS;

export const WEB_ACCESS_TOOLS: readonly WebAccessTool[] = Object.freeze(
  Struct.keys(WEB_ACCESS_LABELS),
);

export const isWebAccessTool = Schema.is(Schema.Literals(WEB_ACCESS_TOOLS));

export function admitsWebAccessSource(tool: ToolInfo): boolean {
  const { sourceInfo } = tool;
  if (
    !isWebAccessTool(tool.name) ||
    sourceInfo.origin !== "package" ||
    !/^npm:pi-web-access(?:@[^@:\s/\\]+)?$/.test(sourceInfo.source) ||
    !sourceInfo.baseDir
  )
    return false;
  const root = sourceInfo.baseDir.replace(/\/$/, "");
  const path = sourceInfo.path;
  return path === `${root}/dist/index.js` || path === `${root}/index.ts`;
}
