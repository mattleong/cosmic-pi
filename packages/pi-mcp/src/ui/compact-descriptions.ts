import { quoteText, type CompactIssue } from "pi-code-previews";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpDiscoveryNoticePolicy } from "../discovery/diagnostics.ts";

/** Human issue messages for typed producer facts. Remote diagnostics never become wording here;
 * agent recovery belongs in the issue detail. */
export const mcpBoundaryDescriptions = {
  unavailable: "The server is unavailable",
  "invalid-input": "The request is invalid",
  connection: "Could not connect to the server",
  transport: "Communication with the server failed",
  protocol: "The request and server could not communicate correctly",
  "output-limit": "The response exceeded the output limit",
  cancelled: "The request was cancelled",
  timeout: "The request timed out",
  cleanup: "Connection cleanup is not confirmed",
  "auth-required": "Authentication is required",
  denied: "The request was not permitted",
  "not-found": "The requested item was not found",
  stale: "The request refers to information that is no longer current",
  busy: "The server is busy",
  config: "The server settings are invalid",
  unsupported: "This operation is not supported",
} satisfies Record<McpBoundaryError["kind"], string>;

export const mcpIssueMessages = {
  "validation-failed": "The output did not match the expected format",
  "validation-unavailable": "The output could not be checked",
  "execution-unknown": "Could not confirm the operation's outcome",
  "not-sent": "The request was not sent",
  "cleanup-unconfirmed": "Connection cleanup is not confirmed",
  "credential-unconfirmed": "Credential changes are not confirmed",
  "output-truncated": "Output was cut off or omitted",
  "origin-failed": "The earlier operation reported a failure",
  "output-invalid": "The output did not match the expected format",
  "retained-read-failed": "Could not load the saved output",
  "remote-failure": "The server reported an error",
  failure: "The server reported an error",
  "unclassified-notices": "The server reported additional warnings",
  "discovery-incomplete": "Some servers have not been checked for available tools",
  "retained-output": "Output saved",
  "evidence-incomplete": "Some operation details are unavailable",
  "evidence-overflow": "Some operation details are unavailable",
} as const;

/**
 * Server warnings are quoted by their first line unless they open with agent guidance. The
 * detail lists every notice, unless the message already says all of a single one.
 */
export const mcpNoticesIssue = (
  notices: readonly string[],
): Pick<CompactIssue, "message" | "detail"> => {
  const [first = ""] = notices;
  const { line, detail } = quoteText(first, { limit: 100 });
  const more = notices.length > 1;
  return {
    message: line
      ? `${line}${more ? ` (+${notices.length - 1} more)` : ""}`
      : mcpIssueMessages["unclassified-notices"],
    ...((more || detail) && { detail: notices.join("\n") }),
  };
};

/** Routine discovery notices are informational; the raw notice stays in the detail. */
export const mcpDiscoveryMessage = (policy: McpDiscoveryNoticePolicy): string =>
  policy.reason !== "optional-catalog"
    ? "Cached server details may be out of date"
    : policy.scope === "templates"
      ? "The server does not list resource templates"
      : "The server does not list resources";
