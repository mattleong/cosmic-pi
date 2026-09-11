import { setAuthChallenge } from "../auth/challenge.ts";
import type { McpAuthChallenge } from "../auth/model.ts";
import type { McpBoundaryError } from "../client/errors.ts";
import type { SdkFetchOperation } from "./sdk-fetch.ts";

interface Capture {
  valid: boolean;
  responseSeen: boolean;
  challenge?: McpAuthChallenge;
}
interface Rejection {
  readonly operation: SdkFetchOperation;
  readonly challenge: McpAuthChallenge;
}

const pending = new WeakMap<SdkFetchOperation, Capture>();
const rejected = new WeakMap<Error, Rejection | undefined>();

/** One SDK send owns the evidence, not the connection's most recent response. */
export const beginSdkHttpChallenge = (operation: SdkFetchOperation): ((error?: Error) => void) => {
  const previous = pending.get(operation);
  if (previous !== undefined) previous.valid = false;
  const capture: Capture = { valid: previous === undefined, responseSeen: false };
  pending.set(operation, capture);
  return (error) => {
    if (pending.get(operation) !== capture) return;
    pending.delete(operation);
    if (
      !capture.valid ||
      operation.signal.aborted ||
      capture.challenge === undefined ||
      error === undefined
    )
      return;
    // A reused exception cannot carry authority for two different sends.
    rejected.set(
      error,
      rejected.has(error) ? undefined : { operation, challenge: capture.challenge },
    );
  };
};

/** Called only for a correlated POST, before the SDK parses the response. */
export const captureSdkHttpChallenge = (operation: SdkFetchOperation, response: Response): void => {
  const capture = pending.get(operation);
  if (capture === undefined || !capture.valid || operation.signal.aborted) return;
  if (capture.responseSeen) {
    capture.valid = false;
    return;
  }
  capture.responseSeen = true;
  if (response.status !== 401 && response.status !== 403) return;
  const value = response.headers.get("www-authenticate");
  if (value === null) return;
  capture.challenge = Object.freeze({
    wwwAuthenticate: value.slice(0, 8_193),
    status: response.status,
  });
};

export const sdkHttpChallengeStatus = (
  error: Error,
  operation: SdkFetchOperation,
): McpAuthChallenge["status"] | undefined => {
  const rejection = rejected.get(error);
  return !operation.signal.aborted && rejection?.operation === operation
    ? rejection.challenge.status
    : undefined;
};

export const withSdkHttpChallenge = (
  error: Error,
  operation: SdkFetchOperation,
  boundary: McpBoundaryError,
): McpBoundaryError => {
  const rejection = rejected.get(error);
  return boundary.kind === "auth-required" &&
    !operation.signal.aborted &&
    rejection?.operation === operation
    ? setAuthChallenge(boundary, rejection.challenge)
    : boundary;
};
