/** Importing this door never registers the MCP extension or acquires a connection. */
export * from "./code-mode/protocol.ts";
export {
  projectMcpPresentation,
  projectMcpFailurePresentation,
  type McpPresentation,
} from "./code-mode/presentation.ts";

export {
  classifyMcpDiscoveryNotice,
  mcpUndiscoveredNotice,
  type McpDiscoveryNoticePolicy,
} from "./discovery/diagnostics.ts";
export { projectMcpCompactSummary } from "./ui/compact-summary.ts";
