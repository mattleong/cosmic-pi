import type * as Effect from "effect/Effect";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpGrant, McpRegistrationReceipt } from "./credentials.ts";

/** Operations bound to one identity and one held cross-process owner. */
export interface McpCredentialTransaction {
  readonly read: Effect.Effect<McpGrant | undefined, McpBoundaryError>;
  readonly readRegistration: Effect.Effect<McpRegistrationReceipt | undefined, McpBoundaryError>;
  readonly write: (grant: McpGrant) => Effect.Effect<void, McpBoundaryError>;
  readonly writeRegistration: (
    registration: McpRegistrationReceipt,
  ) => Effect.Effect<void, McpBoundaryError>;
  readonly remove: Effect.Effect<void, McpBoundaryError>;
}
export interface CredentialTransactionGuard {
  readonly checkCurrent?: Effect.Effect<void, McpBoundaryError>;
  readonly isCurrent?: () => boolean;
}
