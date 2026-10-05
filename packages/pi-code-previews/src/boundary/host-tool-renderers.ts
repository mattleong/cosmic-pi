import type { ExtensionAPI, SourceInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { PreviewToolInfo } from "../application/renderer-contract";

export interface PreviewHostTools {
  readonly tools: ReadonlyMap<string, PreviewToolInfo>;
  readonly nativeManager: boolean;
  readonly previewSource: SourceInfo | undefined;
}

/** Public metadata only. Startup deliberately lets discovery failures reach lifecycle handling. */
export function capturePreviewHostTools(pi: ExtensionAPI): PreviewHostTools {
  const tools = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  const commands = pi.getCommands();
  const managers = commands.filter((command) => command.name === "mcp");
  const anchors = commands.filter(
    (command) => command.name === "code-previews" && command.source === "extension",
  );
  return {
    tools,
    previewSource: anchors.length === 1 ? anchors[0]?.sourceInfo : undefined,
    nativeManager:
      managers.length === 1 &&
      managers[0]?.sourceInfo?.source === "builtin" &&
      managers[0]?.sourceInfo?.path === "builtin:mcp",
  };
}

/** Only renderer fields from next() are retained; never treat it as an execution definition. */
export function rendererFields(renderers: ToolRenderers | undefined): ToolRenderers | undefined {
  if (!renderers) return undefined;
  return {
    ...(renderers.renderShell && { renderShell: renderers.renderShell }),
    ...(renderers.renderCall && { renderCall: renderers.renderCall }),
    ...(renderers.renderResult && { renderResult: renderers.renderResult }),
  };
}

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

export function isBuiltinPreviewTool(tool: PreviewToolInfo | undefined): boolean {
  return tool?.sourceInfo.source === "builtin" && tool.sourceInfo.path === `builtin:${tool.name}`;
}

export function isNativePreviewTool(tool: PreviewToolInfo | undefined, name: "codemode" | "mcp") {
  return tool?.sourceInfo.source === "builtin" && tool.sourceInfo.path === `builtin:${name}`;
}
