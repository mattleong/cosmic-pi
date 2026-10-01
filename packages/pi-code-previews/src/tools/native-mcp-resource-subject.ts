export type NativeMcpResourceTool =
  | "read_mcp_resource"
  | "list_mcp_resources"
  | "list_mcp_resource_templates";

const resourceActions: ReadonlyMap<string, string> = new Map<NativeMcpResourceTool, string>([
  ["read_mcp_resource", "read resource"],
  ["list_mcp_resources", "list resources"],
  ["list_mcp_resource_templates", "list templates"],
]);

/** Readable action of one of Pi's native MCP resource tools; undefined for any other name. */
export function nativeMcpResourceAction(name: string): string | undefined {
  return resourceActions.get(name);
}

/** Observed server and URI text only. Listings have no URI and omit an absent server. */
export function nativeMcpResourceSubject(name: string, server: string, uri: string): string {
  return [server, name === "read_mcp_resource" ? uri : ""].filter(Boolean).join(" / ");
}
