import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMcpCommands } from "../settings/controller.ts";
import { makeMcpLifecycle, type McpApplicationBoundaries } from "./lifecycle.ts";

/** Registration is inert. The first resource graph starts only at session_start. */
export const registerMcpApplication = (
  pi: ExtensionAPI,
  boundaries?: McpApplicationBoundaries,
): void => {
  const lifecycle = makeMcpLifecycle(pi, boundaries);
  registerMcpCommands(pi, lifecycle.commands);
  // Pinned Pi marks every successful execute as non-error. Patch only our owned
  // result, leaving the bounded content and details already returned by it intact.
  pi.on("tool_result", (event) => lifecycle.receipts.apply(event));
  pi.on("agent_end", () => lifecycle.receipts.clear());
  pi.on("session_start", (_event, ctx) => lifecycle.start(ctx));
  pi.on("session_tree", (_event, ctx) => lifecycle.start(ctx));
  pi.on("session_shutdown", () => lifecycle.shutdown());
};
