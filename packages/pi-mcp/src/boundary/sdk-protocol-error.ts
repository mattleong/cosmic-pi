import {
  MissingRequiredClientCapabilityError,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  SdkError,
  SdkErrorCode,
  UnsupportedProtocolVersionError,
  UrlElicitationRequiredError,
} from "@modelcontextprotocol/client";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";

/** Project only fixed protocol categories. SDK messages, data and custom codes stay private. */
export const mapSdkProtocolError = (
  error: ProtocolError,
  outcome: McpBoundaryError["outcome"],
): McpBoundaryError => {
  // SDK 2.0 uses InvalidParams for this subclass; older peers may send -32002.
  if (error instanceof ResourceNotFoundError || error.code === ProtocolErrorCode.ResourceNotFound)
    return boundaryError(
      "not-found",
      outcome,
      "MCP server reported a missing resource.",
      "rpc-resource-not-found",
    );
  switch (error.code) {
    case ProtocolErrorCode.MethodNotFound:
      return boundaryError(
        "unsupported",
        outcome,
        "MCP server does not support the requested method.",
        "rpc-method-not-found",
      );
    case ProtocolErrorCode.InvalidParams:
      return boundaryError(
        "protocol",
        outcome,
        "MCP server rejected the request parameters.",
        "rpc-invalid-params",
      );
    case ProtocolErrorCode.InvalidRequest:
      return boundaryError(
        "protocol",
        outcome,
        "MCP server rejected the request structure.",
        "rpc-invalid-request",
      );
    case ProtocolErrorCode.ParseError:
      return boundaryError(
        "protocol",
        outcome,
        "MCP server could not parse the request.",
        "rpc-parse-error",
      );
    case ProtocolErrorCode.InternalError:
      return boundaryError(
        "protocol",
        outcome,
        "MCP server reported an internal error.",
        "rpc-internal-error",
      );
    case ProtocolErrorCode.UrlElicitationRequired:
    case ProtocolErrorCode.MissingRequiredClientCapability:
    case ProtocolErrorCode.UnsupportedProtocolVersion:
      return boundaryError(
        "unsupported",
        outcome,
        "MCP server requires an unsupported interaction, capability, or protocol version.",
      );
    default:
      return boundaryError(
        "protocol",
        outcome,
        "MCP server returned a JSON-RPC error.",
        "rpc-error",
      );
  }
};

/**
 * Classify public SDK client errors shared by HTTP and stdio. Undefined, including an
 * unrecognized SDK error code, leaves the fallback to each transport.
 */
export const mapSdkClientError = <Failure>(
  error: Failure,
  outcome: McpBoundaryError["outcome"],
  unavailable: string,
): McpBoundaryError | undefined => {
  if (
    error instanceof UrlElicitationRequiredError ||
    error instanceof MissingRequiredClientCapabilityError ||
    error instanceof UnsupportedProtocolVersionError
  ) {
    return boundaryError(
      "unsupported",
      outcome,
      "MCP server requires an unsupported interaction, capability, or protocol version.",
    );
  }
  if (error instanceof ProtocolError) return mapSdkProtocolError(error, outcome);
  if (!(error instanceof SdkError)) return undefined;
  switch (error.code) {
    case SdkErrorCode.RequestTimeout:
      return boundaryError("timeout", "unknown", "MCP request timed out.");
    case SdkErrorCode.InvalidResult:
    case SdkErrorCode.UnsupportedResultType:
      return boundaryError("protocol", "completed", "MCP returned an invalid result.");
    case SdkErrorCode.NotConnected:
    case SdkErrorCode.NotInitialized:
    case SdkErrorCode.AlreadyConnected:
      return boundaryError("connection", "not-sent", unavailable);
    case SdkErrorCode.EraNegotiationFailed:
      return boundaryError("protocol", "not-sent", "MCP protocol negotiation failed.");
    default:
      return undefined;
  }
};
