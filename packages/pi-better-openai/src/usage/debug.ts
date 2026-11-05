import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { maskIdentifier } from "pi-cosmic-core/security";
import { formatTimestampOrNever, USAGE_URL } from "./format.ts";
import type { OpenAIProjection } from "./projection.ts";

/**
 * Usage diagnostics as `Name: value` facts; its settings and the current model show elsewhere.
 */
export function usageDiagnosticLines(state: OpenAIProjection, cwd: string): string[] {
  return [
    `Model eligible: ${state.eligible ? "yes" : "no"}`,
    `Auth: ${state.authFound ? "found" : "missing"}`,
    `Account ID: ${maskIdentifier(state.accountId) ?? "none"}`,
    `Last fetch: ${formatTimestampOrNever(state.lastFetchAt)}`,
    `Last update: ${formatTimestampOrNever(state.updatedAt)}`,
    `Last error: ${state.error ?? "none"}`,
    `Endpoint: ${USAGE_URL}`,
    `Auth file: ${state.authPath ? formatDisplayPath(state.authPath, cwd) : "unknown"}`,
  ];
}
