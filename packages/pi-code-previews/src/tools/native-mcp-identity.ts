import { sha256Text } from "pi-cosmic-core";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const NATIVE_MCP_RESOURCE_ACTIONS = {
  read_mcp_resource: "read resource",
  list_mcp_resources: "list resources",
  list_mcp_resource_templates: "list templates",
} as const;
type NativeMcpResourceTool = keyof typeof NATIVE_MCP_RESOURCE_ACTIONS;

const isNativeMcpResourceTool = Schema.is(
  Schema.Literals(Struct.keys(NATIVE_MCP_RESOURCE_ACTIONS)),
);

export function nativeMcpResourceAction(name: string): string | undefined {
  return isNativeMcpResourceTool(name) ? NATIVE_MCP_RESOURCE_ACTIONS[name] : undefined;
}

export function nativeMcpResourceSubject(name: string, server: string, uri: string): string {
  return Arr.join(
    Arr.filter([server, name === "read_mcp_resource" ? uri : ""], Str.isNonEmpty),
    " / ",
  );
}

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

export function nativeMcpIdentity(
  name: string,
  tool?: Pick<ToolInfo, "namespace">,
): NativeMcpIdentity {
  if (isNativeMcpResourceTool(name))
    return { kind: "resource", name, action: NATIVE_MCP_RESOURCE_ACTIONS[name] };
  const identity: NativeMcpIdentity = { kind: "tool", name, registered: tool !== undefined };
  return tool?.namespace ? { ...identity, namespace: tool.namespace.name } : identity;
}

function matchesAlias(name: string, server: string, tool: string): boolean {
  const plain = Fn.pipe(`mcp__${server}__${tool}`, Str.replaceAll(/[^A-Za-z0-9_]/g, "_"));
  if (plain.length <= 64 && name === plain) return true;
  if (!/_[a-f0-9]{8}$/.test(name)) return false;
  return (
    name ===
    `${Fn.pipe(plain, Str.slice(0, 55))}_${Fn.pipe(sha256Text(`${server}\0${tool}`), Str.slice(0, 8))}`
  );
}

export function nativeMcpReceiptMatches(
  identity: NativeMcpIdentity,
  evidence: { readonly server: string; readonly tool: string },
): boolean {
  if (identity.kind === "resource") return evidence.tool === identity.name;
  if (!/^[A-Za-z0-9_-]+$/.test(evidence.server) || !Str.trim(evidence.tool)) return false;
  if (
    identity.registered &&
    identity.namespace !== `mcp__${Fn.pipe(evidence.server, Str.replaceAll("-", "_"))}`
  )
    return false;
  return matchesAlias(identity.name, evidence.server, evidence.tool);
}
