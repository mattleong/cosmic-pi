import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
import { nativeMcpResourceSubject } from "./native-mcp-resource-subject";
import type { NativeMcpIdentity } from "./native-mcp-identity";

/** A root string argument read from an own data property, trimmed as native execution does. */
export function nativeMcpArgumentText<Args>(args: Args, key: string): string {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(args) || Array.isArray(args)) return "";
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
    return Predicate.isString(value) ? value.trim() : "";
  }, "");
}

interface NativeMcpHeading {
  readonly action: string;
  readonly subject: string;
}

/** Pending tools retain their complete alias; a separately matched receipt may confirm names. */
export function nativeMcpHeading<Args>(
  identity: NativeMcpIdentity,
  args: Args,
  receipt?: { readonly server: string; readonly tool: string },
): NativeMcpHeading {
  if (identity.kind === "tool")
    return {
      action: "call",
      subject: receipt ? `${receipt.server} / ${receipt.tool}` : identity.name,
    };
  return {
    action: identity.action,
    subject: nativeMcpResourceSubject(
      identity.name,
      nativeMcpArgumentText(args, "server"),
      nativeMcpArgumentText(args, "uri"),
    ),
  };
}
