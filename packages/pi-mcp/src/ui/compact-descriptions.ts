import type { McpBoundaryError } from "../client/errors.ts";

/** Typed producer facts only. Remote diagnostics are never interpreted as UI instructions. */
export const mcpBoundaryDescriptions = {
  unavailable: "The server is unavailable.",
  "invalid-input": "The request is invalid.",
  connection: "Could not connect to the server.",
  transport: "Communication with the server failed.",
  protocol: "The request and server could not communicate correctly.",
  "output-limit": "The response exceeded the output limit.",
  cancelled: "The request was cancelled.",
  timeout: "The request timed out.",
  cleanup: "Connection cleanup is not confirmed.",
  "auth-required": "Authentication is required.",
  denied: "The request was not permitted.",
  "not-found": "The requested item was not found.",
  stale: "The request refers to information that is no longer current.",
  busy: "The server is busy.",
  config: "The server settings are invalid.",
  unsupported: "This operation is not supported.",
} satisfies Record<McpBoundaryError["kind"], string>;

const issueDescriptions = new Map(
  Object.entries({
    "validation-failed":
      "The operation finished, but its output did not match the expected format.",
    "validation-unavailable": "The operation finished, but its output could not be checked.",
    "execution-unknown": "Could not confirm the operation's outcome.",
    "not-sent": "The request was not sent.",
    "cleanup-unconfirmed": "Connection cleanup is not confirmed.",
    "output-truncated": "Some output was cut short or omitted.",
    "origin-failed": "The earlier operation reported a failure.",
    "output-invalid": "The operation finished, but its output did not match the expected format.",
    "retained-read-failed": "Could not load the saved output.",
    "remote-failure": "The server reported an error.",
    failure: "The server reported an error.",
    "unclassified-notices": "The server reported additional warnings.",
    "discovery-incomplete": "Some servers have not been checked for available tools.",
    "retained-output": "",
  }),
);

export const mcpIssueDescription = (code: string): string | undefined =>
  issueDescriptions.get(code);
