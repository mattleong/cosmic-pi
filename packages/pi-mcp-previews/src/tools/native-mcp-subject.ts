import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";

import {
  nativeMcpResourceAction,
  nativeMcpResourceSubject,
  type NativeMcpResourceTool,
} from "pi-code-previews";

const isResourceTool = (name: string): name is NativeMcpResourceTool =>
  nativeMcpResourceAction(name) !== undefined;

/**
 * What a fresh native MCP definition presents. Dynamic tools take their target from the
 * registered `server/tool` label, which is authoritative; the model-facing name may be
 * sanitized or hash-shortened and is never parsed.
 */
export type NativeMcpIdentity =
  | {
      readonly kind: "resource";
      readonly name: NativeMcpResourceTool;
      readonly action: string;
    }
  | {
      readonly kind: "tool";
      readonly label: string;
      /** Present only when the label splits exactly at the namespace's server name. */
      readonly server?: string;
      readonly tool?: string;
    };

interface NativeMcpDefinitionIdentity {
  readonly name: string;
  readonly label: string;
  readonly namespace?: { readonly name: string } | undefined;
}

/** Captured once when wrapping; later definition mutation does not change the heading. */
export function nativeMcpIdentity(definition: NativeMcpDefinitionIdentity): NativeMcpIdentity {
  const name = invokeHostCallback(() => definition.name, "");
  if (Predicate.isString(name) && isResourceTool(name))
    return { kind: "resource", name, action: nativeMcpResourceAction(name) ?? "" };
  const label = invokeHostCallback(() => definition.label, "");
  const namespace = invokeHostCallback(() => definition.namespace?.name, undefined);
  const text = Predicate.isString(label) ? label : "";
  if (Predicate.isString(namespace) && namespace.startsWith("mcp__")) {
    const server = namespace.slice("mcp__".length);
    const tool = text.slice(server.length + 1);
    if (server && tool && text.startsWith(`${server}/`))
      return { kind: "tool", label: text, server, tool };
  }
  return { kind: "tool", label: text };
}

/** A root string argument read from an own data property, trimmed as native execution does. */
function argumentText<Args>(args: Args, key: string): string {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(args) || Array.isArray(args)) return "";
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return Predicate.isString(value) ? value.trim() : "";
  }, "");
}

export interface NativeMcpHeading {
  readonly action: string;
  readonly subject: string;
}

/** Heading action and target from the definition and the call's own arguments only. */
export function nativeMcpHeading<Args>(identity: NativeMcpIdentity, args: Args): NativeMcpHeading {
  if (identity.kind === "tool")
    return {
      action: "call",
      subject:
        identity.server !== undefined && identity.tool !== undefined
          ? `${identity.server} / ${identity.tool}`
          : identity.label,
    };
  return {
    action: identity.action,
    subject: nativeMcpResourceSubject(
      identity.name,
      argumentText(args, "server"),
      argumentText(args, "uri"),
    ),
  };
}
