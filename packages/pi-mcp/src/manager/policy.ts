import type {
  McpActionChoice,
  McpManagerAction,
  McpManagerBlocked,
  McpManagerServer,
} from "./model.ts";

export const blockedExplanation = (reason: McpManagerBlocked): string =>
  ({
    untrusted: "The session is not trusted. No server or credential actions are available.",
    disabled: "MCP or this server is disabled.",
    invalid: "The server configuration is invalid.",
    "auth-running": "Authentication is running. Execution is suspended until it settles.",
    "auth-suspended":
      "A previous authentication operation did not finish. An explicit sign-in or logout is required.",
    "cleanup-running": "Connection cleanup is still running. Reconnection is blocked.",
    "cleanup-unconfirmed": "Connection cleanup could not be confirmed. Replacement is blocked.",
    "not-applicable": "This action does not apply to the current server state.",
  })[reason];

/** Short labels shared by action hints and dashboard status. */
export const blockedLabel = {
  untrusted: "Session untrusted",
  disabled: "Disabled",
  invalid: "Invalid config",
  "auth-running": "Signing in",
  "auth-suspended": "Auth interrupted",
  "cleanup-running": "Disconnecting",
  "cleanup-unconfirmed": "Cleanup unconfirmed",
} satisfies Record<Exclude<McpManagerBlocked, "not-applicable">, string>;

export const serverActions = (
  row: Omit<McpManagerServer, "actions">,
  trusted: boolean,
  enabled: boolean,
): ReadonlyArray<McpActionChoice> => {
  const restriction: McpManagerBlocked | undefined = !trusted
    ? "untrusted"
    : row.invalid
      ? "invalid"
      : !enabled || !row.enabled
        ? "disabled"
        : undefined;
  const choice = (
    action: McpManagerAction,
    label: string,
    reason?: McpManagerBlocked,
    confirmation?: string,
  ): McpActionChoice => ({ action, label, enabled: reason === undefined, reason, confirmation });
  const block = row.blockedReason;
  const executionBlock = restriction ?? block;
  const authBlock = restriction ?? (block === "auth-suspended" ? undefined : block);
  return [
    choice("inspect", "Inspect"),
    choice("browse", "Browse cached metadata", restriction),
    choice(
      "auth",
      "Sign in",
      authBlock ?? (row.authType !== "oauth" ? "not-applicable" : undefined),
    ),
    choice(
      "connect",
      "Connect without interactive sign-in",
      executionBlock ?? (row.state !== "disconnected" ? "not-applicable" : undefined),
    ),
    choice(
      "refresh",
      row.state === "connected" ? "Refresh metadata" : "Discover metadata, may connect",
      executionBlock,
    ),
    choice(
      "disconnect",
      "Disconnect",
      restriction ??
        (block === "cleanup-unconfirmed" || row.state === "disconnected"
          ? "not-applicable"
          : undefined),
      row.operations > 0 || row.active > 0 || row.queued > 0 || row.state === "connecting"
        ? "Disconnect this server? Active and queued work will be interrupted. Remote side effects are not undone."
        : undefined,
    ),
    choice(
      "logout",
      "Log out locally",
      authBlock ?? (row.authType !== "oauth" ? "not-applicable" : undefined),
      "Delete local credentials? Connections and retained output will be revoked. This does not revoke tokens at the provider.",
    ),
  ];
};

export const authExplanation = (row: Pick<McpManagerServer, "auth" | "authType">): string => {
  switch (row.auth) {
    case "none":
      return "No managed authentication";
    case "unchecked":
      return "Credentials have not been checked in this activation.";
    case "required":
      return "Authentication required";
    case "unavailable":
      return "Credential storage or authentication check unavailable";
    case "ready":
      return row.authType === "env"
        ? "Credential available"
        : "Credentials verified locally, not remote health";
  }
};
