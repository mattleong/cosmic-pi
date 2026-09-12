import type * as Effect from "effect/Effect";
import type { McpBoundaryError } from "../client/errors.ts";
export interface McpResourceSubscription {
  /** Private local generation; never derived from or exposed to the server. */
  readonly identity?: symbol;
  readonly closed: Effect.Effect<void>;
  readonly close: Effect.Effect<void, McpBoundaryError>;
}
export const MCP_RESOURCE_SUBSCRIPTION_LIMITS = Object.freeze({ perOwner: 16, session: 32 });
