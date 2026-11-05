import * as Str from "effect/String";
import { nativeMcpResourceSubject, type NativeMcpIdentity } from "./native-mcp-identity";
import type { HostContainer } from "../shared/untrusted-value";
import { ownString } from "./native-safe-content";
import { nativeMcpCall } from "./native-codemode-subject";

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
      // Before a receipt confirms the remote identity, an unambiguous alias reads the same way.
      subject: receipt
        ? `${receipt.server} / ${receipt.tool}`
        : (nativeMcpCall(identity.name)?.subject ?? identity.name),
    };
  const uri = identity.name === "read_mcp_resource" ? nativeMcpArgumentText(args, "uri") : "";
  return {
    action: identity.action,
    subject: nativeMcpResourceSubject(identity.name, nativeMcpArgumentText(args, "server"), uri),
    ...(uri !== "" && { pathSubject: true as const }),
  };
}
