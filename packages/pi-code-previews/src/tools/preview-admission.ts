import type { SourceInfo, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { PreviewHostTools } from "../boundary/host-tool-renderers";
import { CORE_CODE_PREVIEW_TOOLS, isCodePreviewToolName, type CodePreviewToolName } from "./names";
import { isNativeMcpName } from "./native-mcp-identity";

export const isCorePreviewName = (name: string): name is (typeof CORE_CODE_PREVIEW_TOOLS)[number] =>
  CORE_CODE_PREVIEW_TOOLS.some((tool) => tool === name);

export const isPreviewName = (name: string): boolean =>
  isCodePreviewToolName(name) || isNativeMcpName(name);

export function isBuiltinTool(
  tool: ToolInfo | undefined,
  path: string | undefined = tool?.name,
): boolean {
  return tool?.sourceInfo.source === "builtin" && tool.sourceInfo.path === `builtin:${path}`;
}

export function isSameExtensionSource(
  tool: ToolInfo | undefined,
  source: SourceInfo | undefined,
): boolean {
  const owner = tool?.sourceInfo;
  return (
    owner !== undefined &&
    source !== undefined &&
    source.source !== "builtin" &&
    owner.source === source.source &&
    owner.path === source.path &&
    owner.scope === source.scope &&
    owner.origin === source.origin
  );
}

export function admitsPreviewSource(
  name: string,
  host: PreviewHostTools,
  ownedTools: ReadonlySet<CodePreviewToolName>,
): boolean {
  const tool = host.tools.get(name);
  if (isCorePreviewName(name))
    return (
      isBuiltinTool(tool) ||
      (name === "write" &&
        ownedTools.has("write") &&
        isSameExtensionSource(tool, host.previewSource))
    );
  if (name === "codemode") return isBuiltinTool(tool);
  if (name === "tool_search") return isBuiltinTool(tool, "tool-search");
  return isNativeMcpName(name) && (tool ? isBuiltinTool(tool, "mcp") : host.nativeManager);
}
