import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
} from "@modelcontextprotocol/client";

/** Synthetic remote failures. Private text and data must never leave the SDK boundary. */
export const protocolErrors = [
  {
    name: "method not found",
    code: ProtocolErrorCode.MethodNotFound,
    kind: "unsupported",
    reason: "rpc-method-not-found",
  },
  {
    name: "invalid parameters",
    code: ProtocolErrorCode.InvalidParams,
    kind: "protocol",
    reason: "rpc-invalid-params",
  },
  {
    name: "invalid request",
    code: ProtocolErrorCode.InvalidRequest,
    kind: "protocol",
    reason: "rpc-invalid-request",
  },
  {
    name: "parse rejection",
    code: ProtocolErrorCode.ParseError,
    kind: "protocol",
    reason: "rpc-parse-error",
  },
  {
    name: "internal server error",
    code: ProtocolErrorCode.InternalError,
    kind: "protocol",
    reason: "rpc-internal-error",
  },
  {
    name: "legacy missing resource",
    code: ProtocolErrorCode.ResourceNotFound,
    kind: "not-found",
    reason: "rpc-resource-not-found",
  },
  { name: "custom server error", code: -32099, kind: "protocol", reason: "rpc-error" },
  {
    name: "bare elicitation code",
    code: ProtocolErrorCode.UrlElicitationRequired,
    kind: "unsupported",
    reason: undefined,
  },
  {
    name: "bare capability code",
    code: ProtocolErrorCode.MissingRequiredClientCapability,
    kind: "unsupported",
    reason: undefined,
  },
  {
    name: "bare version code",
    code: ProtocolErrorCode.UnsupportedProtocolVersion,
    kind: "unsupported",
    reason: undefined,
  },
].map(({ name, code, kind, reason }) => ({
  name,
  kind,
  reason,
  error: new ProtocolError(code, "private-server-message expired token", {
    detail: "private-token",
    endpoint: "https://private-server.test/authorize?code=private-code",
  }),
}));
protocolErrors.push({
  name: "typed missing resource",
  kind: "not-found",
  reason: "rpc-resource-not-found",
  error: new ResourceNotFoundError("private-resource://secret", "private-server-message"),
});
