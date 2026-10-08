import * as Schema from "effect/Schema";
import { nativeMcpResourceSubject, type NativeMcpIdentity } from "./native-mcp-identity";
import { ownData } from "./native-safe-content";

/** A root string argument read from an own data property, trimmed as native execution does. */
export function nativeMcpArgumentText<Args>(args: Args, key: string): string {
  return ownData(args, key, Schema.String)?.trim() ?? "";
}

/** Pending tools retain their complete alias; a separately matched receipt may confirm names. */
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
