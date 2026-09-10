import * as Effect from "effect/Effect";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";

/** Exact original names only. An absent allow-list differs from an empty one. */
export const isToolAllowed = (server: McpEffectiveServer, name: string): boolean => {
  const definition = server.definition;
  return (
    server.enabled &&
    definition !== undefined &&
    !definition.denyTools.includes(name) &&
    (definition.allowTools === undefined || definition.allowTools.includes(name))
  );
};

export const requireToolAllowed = (
  server: McpEffectiveServer,
  name: string,
): Effect.Effect<void, McpBoundaryError> =>
  isToolAllowed(server, name)
    ? Effect.void
    : Effect.fail(boundaryError("denied", "not-sent", "MCP tool is not permitted."));
