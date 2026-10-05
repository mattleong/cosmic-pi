import { sha256Text } from "pi-cosmic-core";
import type { PreviewToolInfo } from "../application/renderer-contract";
import { nativeMcpResourceAction, type NativeMcpResourceTool } from "./native-mcp-resource-subject";

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
  return nativeMcpResourceAction(name) !== undefined || /^mcp__[A-Za-z0-9_]+$/.test(name);
}

/** Capture only public metadata. No labels, execution definitions or reverse alias parsing. */
export function nativeMcpIdentity(
  name: string,
  tool?: Pick<PreviewToolInfo, "namespace">,
): NativeMcpIdentity {
  const action = nativeMcpResourceAction(name);
  if (action !== undefined)
    // SAFETY: The shared action lookup recognizes exactly the three native resource tool names.
    return { kind: "resource", name: name as NativeMcpResourceTool, action };
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
