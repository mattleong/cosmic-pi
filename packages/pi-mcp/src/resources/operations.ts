import * as Effect from "effect/Effect";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpReply } from "../client/model.ts";
import type { McpOperation } from "../connection/model.ts";
import type { McpGatewayRequest } from "../tools/model.ts";

/** URIs are opaque server arguments. This feature owns no filesystem or HTTP capability. */
export const readResource = (
  operation: McpOperation,
  input: Extract<McpGatewayRequest, { readonly action: "resources.read" }>,
): Effect.Effect<McpReply, McpBoundaryError> =>
  Effect.gen(function* () {
    yield* operation.checkCurrent;
    if (!operation.capabilities.resources) {
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "MCP server does not advertise resources.",
      );
    }
    return yield* operation.request({ action: "resources.read", uri: input.uri });
  });
