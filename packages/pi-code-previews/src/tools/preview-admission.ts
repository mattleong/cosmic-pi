import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import type { PreviewToolInfo } from "../application/renderer-contract";
import type { PreviewHostTools } from "../boundary/host-tool-renderers";
import { CORE_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "./names";
import { isNativeMcpName } from "./native-mcp-identity";

export const isCorePreviewName = (name: string): name is (typeof CORE_CODE_PREVIEW_TOOLS)[number] =>
  CORE_CODE_PREVIEW_TOOLS.some((tool) => tool === name);

/** Names presentation may claim at all; every other name falls through untouched. */
export const isPreviewName = (name: string): boolean =>
  isCorePreviewName(name) || name === "codemode" || isNativeMcpName(name);

/** Exact public builtin source `builtin:<path>`; the path defaults to the tool's own name. */
export function isBuiltinTool(
  tool: PreviewToolInfo | undefined,
  path: string | undefined = tool?.name,
): boolean {
  return tool?.sourceInfo.source === "builtin" && tool.sourceInfo.path === `builtin:${path}`;
}

/** A write hook installed earlier, proven by this extension's unique command anchor source. */
export function isOwnedWritePreviewTool(
  tool: PreviewToolInfo | undefined,
  source: SourceInfo | undefined,
): boolean {
  const owner = tool?.sourceInfo;
  return (
    !!owner &&
    !!source &&
    source.source !== "builtin" &&
    owner.source === source.source &&
    owner.path === source.path &&
    owner.scope === source.scope &&
    owner.origin === source.origin
  );
}

/**
 * Public source admission shared by rendering, status and write registration: exact builtins,
 * native codemode and MCP, or a write hook this extension already owns.
 */
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
        isOwnedWritePreviewTool(tool, host.previewSource))
    );
  if (name === "codemode") return isBuiltinTool(tool);
  return isNativeMcpName(name) && (tool ? isBuiltinTool(tool, "mcp") : host.nativeManager);
}
