import type { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { McpBoundaryError } from "../../client/errors.ts";
import type { McpResourceSubscription } from "../../resources/subscription-model.ts";
import type { SdkEvents } from "../sdk-events.ts";

/** Only the boundary selects an era. Application owners consume connection health. */
export interface McpProtocolAdapter {
  readonly observe: (
    client: Client,
    events: SdkEvents,
    ackTimeoutMs: number,
    cleanupTimeoutMs: number,
  ) => Effect.Effect<void, McpBoundaryError, Scope.Scope>;
  readonly subscribeResource: (
    client: Client,
    events: SdkEvents,
    uri: string,
    ackTimeoutMs: number,
    cleanupTimeoutMs: number,
    identity?: symbol,
  ) => Effect.Effect<McpResourceSubscription, McpBoundaryError, Scope.Scope>;
  readonly isObservationRequest: (method: string) => boolean;
  readonly sessionExpired: (status: number, headers: Headers) => boolean;
  readonly terminate: (transport: StreamableHTTPClientTransport) => Promise<void>;
}
