import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { isNativeMcpName } from "../tools/native-mcp-identity";
import { createNativeMcpRenderers } from "../tools/native-mcp-render";
import type { CodePreviewRendererPresentation, PreviewToolInfo } from "./renderer-contract";

/**
 * Actual definitions need exact current builtin ownership. Historical calls may precede server
 * connection, but only an independently proven native manager admits their conservative facade.
 * Declining leaves downstream untouched; no execution definition or manager is registered here.
 */
export function selectNativeMcpRenderers(
  name: string,
  tool: PreviewToolInfo | undefined,
  nativeManager: boolean,
  downstream: ToolRenderers | undefined,
  presentation: CodePreviewRendererPresentation,
): ToolRenderers | undefined {
  if (!isNativeMcpName(name)) return undefined;
  if (tool ? tool.name !== name || tool.sourceInfo.path !== "builtin:mcp" : !nativeManager)
    return undefined;
  return createNativeMcpRenderers(
    name,
    tool,
    downstream,
    presentation.scheduleAnimation,
    presentation,
  );
}
