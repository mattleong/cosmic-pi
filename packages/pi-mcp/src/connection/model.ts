import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import type * as Schema from "effect/Schema";
import type { McpExchange } from "../interaction/model.ts";
import type { McpBoundaryError } from "../client/errors.ts";
import type {
  McpCapabilities,
  McpDispatchOptions,
  McpInstructions,
  McpMetadataFamily,
  McpReply,
  McpRequest,
} from "../client/model.ts";
import type { McpEffectiveServer, McpResolvedConfig } from "../config/model.ts";

export interface McpActionBinding {
  readonly server: string;
  readonly identity: string;
  readonly configRevision: number;
  readonly operationRevision: number;
}

export interface McpOperationBinding {
  readonly server: string;
  readonly identity: string;
  readonly configRevision: number;
  /** Private credential identity counter, never a token. Omitted fixtures mean zero. */
  readonly authorizationRevision?: number;
}

/** Internal capability. The ticket and connection owner are checked at every publication. */
export interface McpOperation {
  readonly binding: McpOperationBinding;
  readonly server: McpEffectiveServer;
  readonly owner: string;
  readonly operationId?: string;
  readonly capabilities: McpCapabilities;
  readonly instructions?: McpInstructions | undefined;
  readonly changes: Stream.Stream<McpMetadataFamily>;
  readonly checkCurrent: Effect.Effect<void, McpBoundaryError>;
  /** New remote/UI work additionally requires an accepting, credential-current owner. */
  readonly checkContinuation?: Effect.Effect<void, McpBoundaryError>;
  /** Only bounded local publication belongs here, never remote I/O or another owner wait. */
  readonly commit: <A>(publication: Effect.Effect<A>) => Effect.Effect<A, McpBoundaryError>;
  readonly request: (
    request: McpRequest,
    options?: McpDispatchOptions,
  ) => Effect.Effect<McpReply, McpBoundaryError>;
  readonly subscribeResource?: (uri: string) => Effect.Effect<Schema.Json, McpBoundaryError>;
  readonly exchange?: (
    request: McpRequest,
    options?: McpDispatchOptions,
  ) => Effect.Effect<McpExchange, McpBoundaryError>;
  /** One independent, deadline-bounded owner per key and connection. Waiter cancellation is local. */
  readonly shared: <A>(
    key: string,
    use: (operation: McpOperation) => Effect.Effect<A, McpBoundaryError>,
  ) => Effect.Effect<A, McpBoundaryError>;
  /** Notification consumers are scoped to this connection, not to a requesting caller. */
  readonly forkOwned: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<Fiber.Fiber<A, E>, McpBoundaryError>;
}

export interface McpConnectionReceipt {
  readonly servers: ReadonlyArray<string>;
  readonly cleanup: "confirmed" | "unconfirmed";
}
export interface McpConnectionStatus {
  readonly enabled: boolean;
  readonly trusted: boolean;
  readonly revision: number;
  readonly active: number;
  readonly queued: number;
  readonly servers: ReadonlyArray<{
    readonly id: string;
    readonly scope: "global" | "project";
    readonly enabled: boolean;
    readonly state: "disconnected" | "connecting" | "connected" | "closing" | "blocked";
    readonly protocolVersion?: string;
    readonly observation?: "active" | "failed";
    readonly auth: "none" | "unchecked" | "ready" | "required" | "unavailable";
    readonly operationRevision: number;
    readonly active: number;
    readonly queued: number;
    readonly operations: number;
    readonly blockedReason:
      | "auth-running"
      | "auth-suspended"
      | "cleanup-running"
      | "cleanup-unconfirmed"
      | undefined;
  }>;
}
export interface McpConnectionsOptions {
  /** Captured host callback is total and reads live session trust. */
  readonly isTrusted: () => boolean;
}
export type McpRevocationReason = "authority" | "auth-transition" | "credential" | "connection";
export type McpRevocationListener = (
  servers: ReadonlyArray<string>,
  /** Omitted reasons retain full authority revocation for existing producers. */
  reason?: McpRevocationReason,
) => Effect.Effect<void>;
export interface McpConnectionsContract {
  /** Synchronous host projection only. Effect admission remains authoritative. */
  readonly isAvailable: () => boolean;
  readonly config: Effect.Effect<McpResolvedConfig>;
  readonly status: Effect.Effect<McpConnectionStatus>;
  readonly resourceSubscriptions?: (server: string) => Effect.Effect<Schema.Json, McpBoundaryError>;
  readonly unsubscribeResource?: (
    server: string,
    uri: string,
  ) => Effect.Effect<Schema.Json, McpBoundaryError>;
  readonly readEvents?: (
    server: string,
    cursor?: string,
    limit?: number,
  ) => Effect.Effect<Schema.Json, McpBoundaryError>;
  readonly requireServer: (id: string) => Effect.Effect<McpEffectiveServer, McpBoundaryError>;
  /** Explicit user authentication only. Serializes auth, suspends execution, and revokes results.
   * Failure/interruption keeps execution suspended until a successful explicit auth retry. */
  readonly withAuth: <A>(
    serverId: string,
    use: (server: McpEffectiveServer) => Effect.Effect<A, McpBoundaryError>,
    expected?: McpActionBinding,
  ) => Effect.Effect<A, McpBoundaryError>;
  readonly withOperation: <A>(
    serverId: string,
    intent: { readonly tool?: string; readonly expected?: McpActionBinding },
    use: (operation: McpOperation) => Effect.Effect<A, McpBoundaryError>,
  ) => Effect.Effect<A, McpBoundaryError>;
  readonly connect: (
    serverId: string,
    expected?: McpActionBinding,
  ) => Effect.Effect<McpConnectionStatus, McpBoundaryError>;
  readonly disconnect: (
    serverId: string,
    expected?: McpActionBinding,
  ) => Effect.Effect<McpConnectionReceipt, McpBoundaryError>;
  readonly checkAction: (expected: McpActionBinding) => Effect.Effect<void, McpBoundaryError>;
  /** Local invalidation callback. Never reenter this service from the callback. */
  readonly subscribeChanges: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  readonly revoke: (serverId?: string) => Effect.Effect<McpConnectionReceipt>;
  /** Local-only callbacks run inside the authority commit. Never reenter connections. */
  readonly subscribeRevocations: (
    listener: McpRevocationListener,
  ) => Effect.Effect<void, never, Scope.Scope>;
}
