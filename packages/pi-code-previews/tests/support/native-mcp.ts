import type { ExtensionFactory, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { animationSchedulerProbe } from "../../src/testing/tool-presentation";
import { createNativeMcpRenderers } from "../../src/tools/native-mcp-render";

/** The header Pi puts before native output it truncated. */
export const NATIVE_TRUNCATION_HEADER =
  "Warning: truncated output (original token count: 9000)\nTotal output lines: 900\n\n";

/** Native MCP renderers for a definition, with no downstream renderer. */
export const styleNativeMcp = (
  definition: Pick<ToolInfo, "name" | "namespace">,
  schedule = animationSchedulerProbe().schedule,
) =>
  createNativeMcpRenderers(definition.name, definition, undefined, { scheduleAnimation: schedule });

/** A stand-in native MCP manager: the `mcp` command and one `mcp__docs__lookup` tool. */
export function nativeManagerFixture() {
  const definition: ToolDefinition = {
    name: "mcp__docs__lookup",
    label: "docs/lookup",
    description: "Owned native definition fixture",
    parameters: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    exposure: "direct",
    namespace: { name: "mcp__docs" },
    annotations: { readOnlyHint: true, openWorldHint: true },
    execute: () =>
      Promise.resolve({
        content: [
          { type: "text", text: "TEXT_RETAINED" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
        structuredContent: { retained: true },
        isError: false,
        details: { server: "docs", tool: "lookup" },
      }),
  };
  const factory: ExtensionFactory = (pi) => {
    pi.registerCommand("mcp", { handler: () => Promise.resolve() });
    pi.on("session_start", () => {
      pi.registerTool(definition);
    });
  };
  return { factory, definition };
}
