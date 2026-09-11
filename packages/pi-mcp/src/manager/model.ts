import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpActionBinding, McpConnectionStatus } from "../connection/model.ts";
import type {
  McpCachedDetail,
  McpCatalogState,
  McpCachedPage,
  McpCachedRef,
  McpCachedRequest,
  McpMetadataSummary,
} from "../discovery/model.ts";

export type McpManagerAction =
  | "inspect"
  | "browse"
  | "auth"
  | "connect"
  | "refresh"
  | "disconnect"
  | "logout";
export type McpManagerBlocked =
  | "untrusted"
  | "disabled"
  | "invalid"
  | "auth-running"
  | "auth-suspended"
  | "cleanup-running"
  | "cleanup-unconfirmed"
  | "not-applicable";
export interface McpActionChoice {
  readonly action: McpManagerAction;
  readonly label: string;
  readonly enabled: boolean;
  readonly reason: McpManagerBlocked | undefined;
  readonly confirmation: string | undefined;
}
export interface McpManagerServer {
  readonly id: string;
  readonly scope: "global" | "project";
  readonly transport: "http" | "stdio" | "invalid";
  readonly enabled: boolean;
  readonly invalid: boolean;
  readonly diagnostic: string | undefined;
  readonly authType: "none" | "env" | "oauth";
  readonly auth: McpConnectionStatus["servers"][number]["auth"];
  readonly state: McpConnectionStatus["servers"][number]["state"];
  readonly blockedReason: McpConnectionStatus["servers"][number]["blockedReason"];
  readonly active: number;
  readonly queued: number;
  readonly operations: number;
  readonly metadata: McpMetadataSummary | undefined;
  readonly metadataState: McpCatalogState | "unavailable" | "checking";
  readonly configRevision: number;
  readonly operationRevision: number;
  readonly actions: ReadonlyArray<McpActionChoice>;
}
export interface McpManagerSnapshot {
  readonly revision: number;
  readonly trusted: boolean;
  readonly enabled: boolean;
  readonly active: number;
  readonly queued: number;
  readonly servers: ReadonlyArray<McpManagerServer>;
}
export interface McpManagerTicket {
  readonly binding: McpActionBinding;
  readonly action: McpManagerAction;
  readonly confirmation: string | undefined;
}
export interface McpManagerContract {
  readonly withView: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E | McpBoundaryError>;
  /** Fresh local reads, never gateway status or credential lookup. */
  readonly refresh: Effect.Effect<McpManagerSnapshot>;
  readonly snapshot: () => McpManagerSnapshot;
  readonly subscribe: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
  readonly capture: (
    row: McpManagerServer,
    action: McpManagerAction,
  ) => Effect.Effect<McpManagerTicket, McpBoundaryError>;
  readonly check: (ticket: McpManagerTicket) => Effect.Effect<void, McpBoundaryError>;
  readonly dispatch: (
    ticket: McpManagerTicket,
  ) => Effect.Effect<McpMetadataSummary | undefined, McpBoundaryError>;
  readonly cached: (request: McpCachedRequest) => Effect.Effect<McpCachedPage, McpBoundaryError>;
  readonly cachedDetail: (ref: McpCachedRef) => Effect.Effect<McpCachedDetail, McpBoundaryError>;
}
