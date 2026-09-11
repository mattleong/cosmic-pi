import type { McpBoundaryError } from "../client/errors.ts";
import type { McpAuthChallenge } from "./model.ts";

const challenges = new WeakMap<McpBoundaryError, McpAuthChallenge>();

export const getAuthChallenge = (error: McpBoundaryError): McpAuthChallenge | undefined =>
  challenges.get(error);

/** Keep one overflow character so the strict parser rejects an oversized header. */
export const setAuthChallenge = (
  error: McpBoundaryError,
  challenge: McpAuthChallenge,
): McpBoundaryError => {
  challenges.set(
    error,
    Object.freeze({
      wwwAuthenticate: challenge.wwwAuthenticate.slice(0, 8_193),
      status: challenge.status,
    }),
  );
  return error;
};

export const copyAuthChallenge = (
  from: McpBoundaryError,
  to: McpBoundaryError,
): McpBoundaryError => {
  const challenge = challenges.get(from);
  if (challenge !== undefined) challenges.set(to, challenge);
  else challenges.delete(to);
  return to;
};
