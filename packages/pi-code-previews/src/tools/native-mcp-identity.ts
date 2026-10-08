import { sha256Text } from "pi-cosmic-core";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** Readable actions of Pi's native MCP resource tools. */
const NATIVE_MCP_RESOURCE_ACTIONS = {
  read_mcp_resource: "read resource",
  list_mcp_resources: "list resources",
  list_mcp_resource_templates: "list templates",
} as const;
type NativeMcpResourceTool = keyof typeof NATIVE_MCP_RESOURCE_ACTIONS;

const isNativeMcpResourceTool = (name: string): name is NativeMcpResourceTool =>
  Object.hasOwn(NATIVE_MCP_RESOURCE_ACTIONS, name);

/** Readable action of one of Pi's native MCP resource tools; undefined for any other name. */
export function nativeMcpResourceAction(name: string): string | undefined {
  return isNativeMcpResourceTool(name) ? NATIVE_MCP_RESOURCE_ACTIONS[name] : undefined;
}

/** Observed server and URI text only. Listings have no URI and omit an absent server. */
export function nativeMcpResourceSubject(name: string, server: string, uri: string): string {
  return [server, name === "read_mcp_resource" ? uri : ""].filter(Boolean).join(" / ");
}

/** Public aliases identify rows, not exact remote names: sanitization is not reversible. */
export type NativeMcpIdentity =
  | { readonly kind: "resource"; readonly name: NativeMcpResourceTool; readonly action: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly registered: boolean;
      readonly namespace?: string;
    };

export function isNativeMcpName(name: string): boolean {
  return isNativeMcpResourceTool(name) || /^mcp__[A-Za-z0-9_]+$/.test(name);
}

/** Capture only public metadata. No labels, execution definitions or reverse alias parsing. */
export function nativeMcpIdentity(
  name: string,
  tool?: Pick<ToolInfo, "namespace">,
): NativeMcpIdentity {
  if (isNativeMcpResourceTool(name))
    return { kind: "resource", name, action: NATIVE_MCP_RESOURCE_ACTIONS[name] };
  const identity: NativeMcpIdentity = { kind: "tool", name, registered: tool !== undefined };
  return tool?.namespace ? { ...identity, namespace: tool.namespace.name } : identity;
}

/**
 * Verify a receipt's already-observed names in the forward direction only. Pi limits aliases to
 * 64 characters and adds eight SHA-256 hex characters for long or colliding sanitized names.
 * This tiny matcher never searches candidate names or expands hashes into invented identities.
 */
function matchesAlias(name: string, server: string, tool: string): boolean {
  const plain = `mcp__${server}__${tool}`.replaceAll(/[^A-Za-z0-9_]/g, "_");
  if (plain.length <= 64 && name === plain) return true;
  if (!/_[a-f0-9]{8}$/.test(name)) return false;
  return name === `${plain.slice(0, 55)}_${sha256Text(`${server}\0${tool}`).slice(0, 8)}`;
}

/** Exact names may be displayed only after a native receipt matches alias and namespace. */
export function nativeMcpReceiptMatches(
  identity: NativeMcpIdentity,
  evidence: { readonly server: string; readonly tool: string },
): boolean {
  if (identity.kind === "resource") return evidence.tool === identity.name;
  if (!/^[A-Za-z0-9_-]+$/.test(evidence.server) || !evidence.tool.trim()) return false;
  if (identity.registered && identity.namespace !== `mcp__${evidence.server.replaceAll("-", "_")}`)
    return false;
  return matchesAlias(identity.name, evidence.server, evidence.tool);
}
