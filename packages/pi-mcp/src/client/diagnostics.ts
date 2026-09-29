import type { McpBoundaryError } from "./errors.ts";
import { mcpRequestGuidance } from "../tools/request-guidance.ts";
import { MCP_DISCOVERY_ACTIONS } from "../discovery/model.ts";

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
  readonly action?: string;
}

/** Static diagnostics. A `"sign-in"` recovery offers sign-in when available, else status. */
type Entry = readonly [
  title: string,
  explanation: string,
  recovery: ReadonlyArray<McpRecovery> | "sign-in",
  severity?: McpDiagnostic["severity"],
];
type Reason = NonNullable<McpBoundaryError["reason"]>;
const REASONS = {
  "auth-not-configured": [
    "Managed authentication is not configured",
    "Managed authentication is disabled for this HTTP server, or custom headers keep it outside implicit OAuth. Review /mcp settings and the server's authentication headers. Explicit auth: false or auth: none does not enable OAuth. Headerless HTTP servers with omitted auth can use explicit user-approved OAuth sign-in after an authentication challenge.",
    ["inspect-settings"],
  ],
  "auth-env-required": [
    "Environment credential required",
    "The configured environment credential is missing, invalid, or rejected. Check the credential supplied to Pi and the server's auth settings. Browser sign-in is unavailable for environment authentication.",
    ["inspect-settings"],
  ],
  "auth-env-sign-in-unsupported": [
    "Browser sign-in is unavailable",
    "This server uses an environment credential, not OAuth. /mcp auth cannot start browser sign-in for it. No credential check was performed. Review the server's auth settings if you intended to use OAuth.",
    ["inspect-settings"],
  ],
  "auth-oauth-required": [
    "OAuth sign-in required",
    "The OAuth credential check or transport rejected access. Use /mcp auth for this server or its Sign in action. Sign-in is an explicit user action and does not connect automatically.",
    "sign-in",
  ],
  "oauth-refresh-unresolved": [
    "Credential refresh unresolved",
    "A refresh may have rotated credentials without a confirmed saved result. The old grant is blocked from reuse. Review credential status and storage before an explicit new sign-in; do not repeat the refresh or failed operation automatically.",
    ["check-storage", "inspect-status"],
    "error",
  ],
  "oauth-token-rejected": [
    "OAuth token rejected",
    "The server rejected the credential used by this operation. It will not be reused or refreshed as recovery for this rejection. Review access before an explicit user-approved sign-in. The failed operation was not replayed.",
    "sign-in",
  ],
  "oauth-insufficient-scope": [
    "OAuth permissions insufficient",
    "The server requires permission review. Inspect the requested permissions and server settings before explicit user-approved sign-in with an approved scope proposal. Repeating sign-in with unchanged permissions is not a fix, and no failed operation was replayed.",
    ["inspect-settings"],
  ],
  "oauth-scope-approval-required": [
    "Permission approval required",
    "Additional OAuth permissions need explicit user approval. Review the permission proposal in an interactive sign-in dialog. No expanded permission request was authorized or sent automatically.",
    ["inspect-settings"],
  ],
  "oauth-scope-invalid": [
    "OAuth permission request rejected",
    "The server challenge or requested permissions were malformed, conflicting, or exceeded safe limits. Review the server and authentication settings. Invalid scope evidence cannot authorize expanded access.",
    ["inspect-settings"],
    "error",
  ],
  "oauth-resource-metadata-missing": [
    "Resource metadata is missing",
    "The resource did not publish protected-resource metadata, and the configured policy disables compatibility fallback. Review allowMissingResourceMetadata; no setting was changed.",
    ["inspect-settings"],
  ],
  "oauth-resource-metadata-invalid": [
    "Resource metadata was rejected",
    "Protected-resource discovery returned malformed or unsafe metadata, or an unexpected HTTP response. Compatibility fallback cannot bypass these failures.",
    ["inspect-settings"],
    "error",
  ],
  "oauth-storage-unavailable": [
    "Secure storage unavailable",
    "Credentials could not be checked or saved in macOS Keychain. This does not mean you are signed out.",
    ["check-storage"],
    "error",
  ],
  "oauth-mutation-unresolved": [
    "Credential mutation unresolved",
    "A native credential mutation is pending or access remains blocked after interruption. A grant may have been saved. Cancellation does not remove credentials. Do not start another sign-in until storage admission permits it.",
    ["wait-for-storage", "inspect-status"],
    "error",
  ],
  "oauth-callback-timeout": [
    "Sign-in deadline expired",
    "The authorization response did not complete within this attempt's budget. Its callback and browser actions are no longer available.",
    "sign-in",
  ],
  "oauth-registration-unsupported": [
    "Public-client sign-in unsupported",
    "The provider or configured registration does not support the required public-client and PKCE flow. Review the server's registration settings.",
    ["inspect-settings"],
  ],
  "oauth-pkce-unsupported": [
    "PKCE S256 is not advertised",
    "The authorization-server metadata does not advertise PKCE S256. Sign-in stopped without weakening the authorization-code flow.",
    ["inspect-settings"],
  ],
  "oauth-client-auth-method-unsupported": [
    "Registered client authentication unsupported",
    "The client registration selected a token authentication method other than none. This extension supports public clients only; it did not switch authentication methods or send a client secret.",
    ["inspect-settings"],
  ],
  "oauth-client-auth-method-ambiguous": [
    "Registered client authentication is ambiguous",
    "The client registration returned a secret without explicitly selecting token authentication method none. The extension cannot assume public-client authentication, so it stopped before token exchange.",
    ["inspect-settings"],
  ],
  "oauth-binding-rejected": [
    "Authentication binding rejected",
    "The issuer, resource, callback, or public-client binding did not match the approved configuration. No security check was bypassed.",
    ["inspect-settings"],
    "error",
  ],
  "oauth-deletion-failed": [
    "Local deletion was not confirmed",
    "Connection and result access were revoked, but local credential deletion failed or is unresolved. No provider-side revocation is claimed.",
    ["check-storage", "inspect-status"],
    "error",
  ],
  "oauth-finalization-failed": [
    "Credentials saved; sign-in not finalized",
    "A grant was saved, but the connection fence did not finish successfully. Sign-in is not reported as successful. Inspect access and cleanup before another action.",
    ["inspect-status"],
    "error",
  ],
  "rpc-method-not-found": [
    "Method unavailable",
    "The MCP server reported JSON-RPC error -32601, method not found.",
    ["inspect-settings"],
  ],
  "rpc-invalid-params": [
    "Parameters rejected",
    "The MCP server reported JSON-RPC error -32602, invalid parameters.",
    ["inspect-operation"],
  ],
  "rpc-invalid-request": [
    "Request rejected",
    "The MCP server reported JSON-RPC error -32600, invalid request.",
    ["inspect-operation"],
  ],
  "rpc-parse-error": [
    "Request parsing failed",
    "The MCP server reported JSON-RPC error -32700, parse error.",
    ["inspect-operation"],
  ],
  "rpc-internal-error": [
    "Server error",
    "The MCP server reported JSON-RPC error -32603, internal error.",
    ["inspect-status"],
  ],
  "rpc-resource-not-found": [
    "Resource unavailable",
    "The MCP server reported that the requested resource was not found.",
    ["inspect-operation"],
  ],
  "rpc-error": [
    "Server JSON-RPC error",
    "The MCP server returned a JSON-RPC error. Its private message and data were not exposed.",
    ["inspect-operation"],
  ],
} satisfies Partial<Record<Reason, Entry>>;
const KINDS = {
  "auth-required": [
    "Authentication required",
    "A credential check or transport rejected access. Inspect the server's authentication settings. Browser sign-in requires configured OAuth and an explicit user action.",
    "sign-in",
  ],
  cancelled: [
    "Operation cancelled",
    "The operation was cancelled. Cancellation does not undo work that already completed.",
    ["inspect-status"],
    "info",
  ],
  cleanup: [
    "Cleanup not confirmed",
    "Access remains blocked because resource cleanup could not be confirmed. A new connection is not a safe recovery yet.",
    ["inspect-status"],
    "error",
  ],
  stale: [
    "Action no longer current",
    "The session, target, or operation changed. Open its current details before choosing another action.",
    ["inspect-status"],
  ],
  busy: [
    "Operation already active",
    "An operation already owns admission. Inspect the active operation instead of starting a duplicate.",
    ["inspect-status"],
    "info",
  ],
  denied: [
    "Action not permitted",
    "Trust or server policy does not permit this action. This is not evidence that stored credentials expired.",
    ["inspect-settings"],
  ],
  unsupported: [
    "Action unsupported",
    "This server or host mode does not support the requested action.",
    ["inspect-settings"],
  ],
  timeout: [
    "Operation deadline expired",
    "The operation exceeded its enforced deadline. Inspect its state before starting another action.",
    ["inspect-status"],
  ],
  "not-found": [
    "Item unavailable",
    "The requested item is missing, expired, or revoked. It will not be recreated by replaying an operation.",
    ["inspect-status"],
  ],
  "output-limit": [
    "Output allowance exceeded",
    "The requested output could not fit the configured allowance. Inspect the operation details and output limits.",
    ["inspect-operation"],
  ],
} satisfies Partial<Record<McpBoundaryError["kind"], Entry>>;
const FALLBACK: Entry = [
  "MCP operation failed",
  "The operation could not finish. Inspect server status and configuration for a safe next action.",
  ["inspect-status"],
  "error",
];
const own = <K extends string>(table: Partial<Record<K, Entry>>, key: K | undefined) =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

const failureDiagnostic = (error: Evidence, actions: DiagnosticActions): McpDiagnostic => {
  const signIn: ReadonlyArray<McpRecovery> = actions.canSignIn ? ["sign-in"] : ["inspect-status"];
  if (error.reason === "gateway-request-invalid")
    return diagnostic(
      "MCP arguments rejected",
      `${mcpRequestGuidance(actions.action)} No rejected action was dispatched.`,
      [],
    );
  if (error.reason === "oauth-browser-open-failed")
    return diagnostic(
      "Browser did not open",
      actions.canReopen
        ? "The same sign-in attempt is still waiting. Reopen its browser without restarting sign-in or extending the deadline."
        : "The browser could not be opened. This attempt cannot be reopened now.",
      actions.canReopen ? ["reopen-browser"] : signIn,
    );
  const reason = own(REASONS, error.reason);
  if (reason === undefined && (error.kind === "config" || error.kind === "invalid-input"))
    return diagnostic(
      "Configuration or input rejected",
      error.outcome === "not-sent"
        ? "Review the selected server and supported arguments. No rejected action was dispatched."
        : "Review the selected server and supported arguments. This error does not establish that the request was never dispatched.",
      ["inspect-settings"],
    );
  const [title, explanation, recovery, severity] = reason ?? own(KINDS, error.kind) ?? FALLBACK;
  return diagnostic(title, explanation, recovery === "sign-in" ? signIn : recovery, severity);
};

/** Whether an explicit user sign-in is this failure's remedy, whatever the host can offer now. */
export const mcpSignInRemedy = (error: Pick<Evidence, "kind" | "reason">): boolean =>
  (own(REASONS, error.reason) ?? own(KINDS, error.kind))?.[2] === "sign-in";

/** Fixed reasons only. Neither completion nor a failure diagnostic proves output was retained. */
export const mcpDiagnostic = (error: Evidence, actions: DiagnosticActions = {}): McpDiagnostic => {
  if (error.outcome === "unknown") {
    const discovery =
      actions.action === "refresh" ||
      MCP_DISCOVERY_ACTIONS.some((action) => action === actions.action);
    const explanation = discovery
      ? "The connection or metadata discovery request may have run, but completion is unconfirmed. No tool invocation was requested. Inspect server status before continuing. The request was not replayed."
      : "The remote operation may have run. Inspect its outcome before starting more work. It was not replayed.";
    return diagnostic(
      discovery ? "Discovery outcome unknown" : "Outcome unknown",
      error.reason !== undefined || error.kind === "auth-required"
        ? `${explanation} ${failureDiagnostic(error, {}).explanation}`
        : explanation,
      ["inspect-operation"],
      "error",
    );
  }
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
