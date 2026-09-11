import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import { copyAuthChallenge } from "./challenge.ts";

/** Capture only the admitted auth mode, never credentials or a later configuration. */
export const withAuthFailureReason = (
  server: McpEffectiveServer,
  error: McpBoundaryError,
): McpBoundaryError => {
  const definition = server.definition;
  if (
    error.kind !== "auth-required" ||
    error.reason !== undefined ||
    definition?.transport !== "http"
  )
    return error;
  const reason =
    definition.auth.type === "none"
      ? "auth-not-configured"
      : definition.auth.type === "env"
        ? "auth-env-required"
        : "auth-oauth-required";
  return copyAuthChallenge(error, boundaryError(error.kind, error.outcome, error.message, reason));
};
