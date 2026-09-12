import { ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { boundaryError, McpBoundaryError } from "../../../client/errors.ts";
import { mapSdkProtocolError } from "../../sdk-protocol-error.ts";

/** Without HTTP operation evidence, only SDK predispatch failures prove no send. */
export const mapSubscriptionFailure = (cause: unknown): McpBoundaryError => {
  if (cause instanceof McpBoundaryError) return cause;
  if (cause instanceof ProtocolError) return mapSdkProtocolError(cause, "completed");
  if (cause instanceof SdkError) {
    switch (cause.code) {
      case SdkErrorCode.MethodNotSupportedByProtocolVersion:
        return boundaryError("unsupported", "not-sent", "MCP subscriptions are unavailable.");
      case SdkErrorCode.NotConnected:
      case SdkErrorCode.NotInitialized:
        return boundaryError("connection", "not-sent", "MCP connection is unavailable.");
      case SdkErrorCode.RequestTimeout:
        return boundaryError("timeout", "unknown", "MCP subscription acknowledgement timed out.");
    }
  }
  return boundaryError("transport", "unknown", "MCP subscription was not acknowledged.");
};
