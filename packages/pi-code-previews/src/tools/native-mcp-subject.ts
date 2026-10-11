import * as Schema from "effect/Schema";
import { nativeMcpResourceSubject, type NativeMcpIdentity } from "./native-mcp-identity";
import { ownData } from "./native-safe-content";

export function nativeMcpArgumentText<Args>(args: Args, key: string): string {
  return ownData(args, key, Schema.String)?.trim() ?? "";
}

export function nativeMcpHeading<Args>(
  identity: NativeMcpIdentity,
  args: Args,
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
