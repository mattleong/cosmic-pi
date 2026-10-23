import * as Str from "effect/String";
import { nativeMcpResourceSubject, type NativeMcpIdentity } from "./native-mcp-identity";
import type { HostContainer } from "../shared/untrusted-value";
import { ownString } from "./native-safe-content";

export function nativeMcpArgumentText(args: HostContainer | undefined, key: string): string {
  const text = ownString(args, key);
  return text === undefined ? "" : Str.trim(text);
}

export function nativeMcpHeading(
  identity: NativeMcpIdentity,
  args: HostContainer | undefined,
  receipt?: { readonly server: string; readonly tool: string },
) {
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
