import type { ExtensionAPI, SourceInfo } from "@earendil-works/pi-coding-agent";
import type { PreviewToolInfo } from "../application/renderer-contract";

export interface PreviewHostTools {
  readonly tools: ReadonlyMap<string, PreviewToolInfo>;
  readonly nativeManager: boolean;
  readonly previewSource: SourceInfo | undefined;
}

/** Public metadata only. Startup deliberately lets discovery failures reach lifecycle handling. */
export function capturePreviewHostTools(
  pi: ExtensionAPI,
  anchorCommand = "code-previews",
): PreviewHostTools {
  const tools = new Map<string, PreviewToolInfo>();
  const repeated = new Set<string>();
  for (const tool of pi.getAllTools()) {
    if (tools.has(tool.name)) repeated.add(tool.name);
    tools.set(tool.name, tool);
  }
  // A name listed twice proves no single owner, so it reads as unknown.
  for (const name of repeated) tools.delete(name);
  const commands = pi.getCommands();
  const managers = commands.filter((command) => command.name === "mcp");
  const anchors = commands.filter(
    (command) => command.name === anchorCommand && command.source === "extension",
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
