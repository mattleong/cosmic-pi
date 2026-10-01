import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { notifyAtHostBoundary, registerExtensionCommand } from "pi-cosmic-core";
import { getNativeMcpStatus } from "../application/native-mcp-registration";

/** Status-only ownership anchor; native /mcp remains the sole management interface. */
export function registerMcpPreviewsCommand(pi: ExtensionAPI): void {
  const show = (_args: string, ctx: ExtensionCommandContext): void => {
    const status = getNativeMcpStatus();
    notifyAtHostBoundary(
      ctx,
      [
        `MCP previews: ${status.state}${status.presentationFailed ? " · native rendering fallback" : ""}`,
        "Servers: /mcp",
        "Appearance: /code-previews",
      ].join("\n"),
      status.presentationFailed || status.state !== "owned" ? "warning" : "info",
    );
  };
  registerExtensionCommand(pi, {
    name: "mcp-previews",
    description: "Show native MCP preview status and health",
    bare: { handler: show },
    subcommands: [
      { name: "status", description: "Show preview ownership status", handler: show },
      { name: "health", description: "Show presentation fallback health", handler: show },
    ],
  });
}
