import type { McpBoundaryError } from "./errors.ts";

export type McpRecovery =
  | "inspect-settings"
  | "inspect-status"
  | "inspect-operation"
  | "check-storage"
  | "wait-for-storage"
  | "reopen-browser"
  | "sign-in";
export interface McpDiagnostic {
  readonly title: string;
  readonly explanation: string;
  readonly severity: "info" | "warning" | "error";
  readonly recovery: ReadonlyArray<McpRecovery>;
}
type Evidence = Pick<McpBoundaryError, "kind" | "outcome"> & {
  readonly reason?: McpBoundaryError["reason"];
};
const diagnostic = (
  title: string,
  explanation: string,
  recovery: ReadonlyArray<McpRecovery>,
  severity: McpDiagnostic["severity"] = "warning",
): McpDiagnostic =>
  Object.freeze({ title, explanation, severity, recovery: Object.freeze([...recovery]) });

interface DiagnosticActions {
  readonly canReopen?: boolean;
  readonly canSignIn?: boolean;
}

const failureDiagnostic = (error: Evidence, actions: DiagnosticActions): McpDiagnostic => {
  const signIn: ReadonlyArray<McpRecovery> = actions.canSignIn ? ["sign-in"] : ["inspect-status"];
  switch (error.reason) {
    case "oauth-resource-metadata-missing":
      return diagnostic(
        "Resource metadata is missing",
        "The resource did not publish protected-resource metadata. An explicit compatibility setting is available only with a configured issuer. Review the configuration; no setting was changed.",
        ["inspect-settings"],
      );
    case "oauth-resource-metadata-invalid":
      return diagnostic(
        "Resource metadata was rejected",
        "The protected-resource metadata is malformed or unsafe. The missing-metadata compatibility setting cannot bypass this rejection.",
        ["inspect-settings"],
        "error",
      );
    case "oauth-storage-unavailable":
      return diagnostic(
        "Secure storage unavailable",
        "Credentials could not be checked or saved in macOS Keychain. This does not mean you are signed out.",
        ["check-storage"],
        "error",
      );
    case "oauth-mutation-unresolved":
      return diagnostic(
        "Credential mutation unresolved",
        "A native credential mutation is pending or access remains blocked after interruption. A grant may have been saved. Cancellation does not remove credentials. Do not start another sign-in until storage admission permits it.",
        ["wait-for-storage", "inspect-status"],
        "error",
      );
    case "oauth-browser-open-failed":
      return diagnostic(
        "Browser did not open",
        actions.canReopen
          ? "The same sign-in attempt is still waiting. Reopen its browser without restarting sign-in or extending the deadline."
          : "The browser could not be opened. This attempt cannot be reopened now.",
        actions.canReopen ? ["reopen-browser"] : signIn,
      );
    case "oauth-callback-timeout":
      return diagnostic(
        "Sign-in deadline expired",
        "The authorization response did not complete within this attempt's budget. Its callback and browser actions are no longer available.",
        signIn,
      );
    case "oauth-registration-unsupported":
      return diagnostic(
        "Public-client sign-in unsupported",
        "The provider or configured registration does not support the required public-client and PKCE flow. Review the server's registration settings.",
        ["inspect-settings"],
      );
    case "oauth-binding-rejected":
      return diagnostic(
        "Authentication binding rejected",
        "The issuer, resource, callback, or public-client binding did not match the approved configuration. No security check was bypassed.",
        ["inspect-settings"],
        "error",
      );
    case "oauth-deletion-failed":
      return diagnostic(
        "Local deletion was not confirmed",
        "Connection and result access were revoked, but local credential deletion failed or is unresolved. No provider-side revocation is claimed.",
        ["check-storage", "inspect-status"],
        "error",
      );
    case "oauth-finalization-failed":
      return diagnostic(
        "Credentials saved; sign-in not finalized",
        "A grant was saved, but the connection fence did not finish successfully. Sign-in is not reported as successful. Inspect access and cleanup before another action.",
        ["inspect-status"],
        "error",
      );
    case "rpc-method-not-found":
      return diagnostic(
        "Method unavailable",
        "The MCP server reported JSON-RPC error -32601, method not found.",
        ["inspect-settings"],
      );
    case "rpc-invalid-params":
      return diagnostic(
        "Parameters rejected",
        "The MCP server reported JSON-RPC error -32602, invalid parameters.",
        ["inspect-operation"],
      );
    case "rpc-invalid-request":
      return diagnostic(
        "Request rejected",
        "The MCP server reported JSON-RPC error -32600, invalid request.",
        ["inspect-operation"],
      );
    case "rpc-parse-error":
      return diagnostic(
        "Request parsing failed",
        "The MCP server reported JSON-RPC error -32700, parse error.",
        ["inspect-operation"],
      );
    case "rpc-internal-error":
      return diagnostic(
        "Server error",
        "The MCP server reported JSON-RPC error -32603, internal error.",
        ["inspect-status"],
      );
    case "rpc-resource-not-found":
      return diagnostic(
        "Resource unavailable",
        "The MCP server reported that the requested resource was not found.",
        ["inspect-operation"],
      );
    case "rpc-error":
      return diagnostic(
        "Server JSON-RPC error",
        "The MCP server returned a JSON-RPC error. Its private message and data were not exposed.",
        ["inspect-operation"],
      );
  }
  switch (error.kind) {
    case "auth-required":
      return diagnostic(
        "Authentication required",
        "A credential check or authenticated transport rejected access. Sign-in is an explicit user action and will not connect automatically.",
        signIn,
      );
    case "cancelled":
      return diagnostic(
        "Operation cancelled",
        "The operation was cancelled. Cancellation does not undo work that already completed.",
        ["inspect-status"],
        "info",
      );
    case "cleanup":
      return diagnostic(
        "Cleanup not confirmed",
        "Access remains blocked because resource cleanup could not be confirmed. A new connection is not a safe recovery yet.",
        ["inspect-status"],
        "error",
      );
    case "stale":
      return diagnostic(
        "Action no longer current",
        "The session, target, or operation changed. Open its current details before choosing another action.",
        ["inspect-status"],
      );
    case "busy":
      return diagnostic(
        "Operation already active",
        "An operation already owns admission. Inspect the active operation instead of starting a duplicate.",
        ["inspect-status"],
        "info",
      );
    case "denied":
      return diagnostic(
        "Action not permitted",
        "Trust or server policy does not permit this action. This is not evidence that stored credentials expired.",
        ["inspect-settings"],
      );
    case "config":
    case "invalid-input":
      return diagnostic(
        "Configuration or input rejected",
        error.outcome === "not-sent"
          ? "Review the selected server and supported arguments. No rejected action was dispatched."
          : "Review the selected server and supported arguments. This error does not establish that the request was never dispatched.",
        ["inspect-settings"],
      );
    case "unsupported":
      return diagnostic(
        "Action unsupported",
        "This server or host mode does not support the requested action.",
        ["inspect-settings"],
      );
    case "timeout":
      return diagnostic(
        "Operation deadline expired",
        "The operation exceeded its enforced deadline. Inspect its state before starting another action.",
        ["inspect-status"],
      );
    case "not-found":
      return diagnostic(
        "Item unavailable",
        "The requested item is missing, expired, or revoked. It will not be recreated by replaying an operation.",
        ["inspect-status"],
      );
    case "output-limit":
      return diagnostic(
        "Output allowance exceeded",
        "The requested output could not fit the configured allowance. Inspect the operation details and output limits.",
        ["inspect-operation"],
      );
    default:
      return diagnostic(
        "MCP operation failed",
        "The operation could not finish. Inspect server status and configuration for a safe next action.",
        ["inspect-status"],
        "error",
      );
  }
};

/** Fixed reasons only. Neither completion nor a failure diagnostic proves output was retained. */
export const mcpDiagnostic = (error: Evidence, actions: DiagnosticActions = {}): McpDiagnostic => {
  if (error.outcome === "unknown")
    return diagnostic(
      "Outcome unknown",
      "The remote operation may have run. Inspect its outcome before starting more work. It was not replayed.",
      ["inspect-operation"],
      "error",
    );
  const completed = error.outcome === "completed";
  const detail = failureDiagnostic(error, completed ? {} : actions);
  return completed
    ? diagnostic(
        detail.title,
        `${detail.explanation} Completion does not imply success. The operation was not replayed.`,
        ["inspect-operation"],
        "error",
      )
    : detail;
};
