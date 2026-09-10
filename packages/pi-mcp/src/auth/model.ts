import type * as Effect from "effect/Effect";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";

/** User command capability. Never accepted by gateway or Code Mode parameters. */
export interface McpLoginUi {
  readonly mode: "local" | "manual";
  readonly openBrowser: (url: string) => Effect.Effect<void, McpBoundaryError>;
  readonly readCallback: (
    authorizationUrl: string,
  ) => Effect.Effect<string | undefined, McpBoundaryError>;
}
export interface McpAuthStatus {
  readonly state: "none" | "ready" | "required" | "unavailable";
}
export interface McpAuthContract {
  /** No interactive fallback. Refresh happens before dispatch; returned token stays internal. */
  readonly access: (
    server: McpEffectiveServer,
  ) => Effect.Effect<string | undefined, McpBoundaryError>;
  readonly status: (server: McpEffectiveServer) => Effect.Effect<McpAuthStatus>;
  readonly login: (
    server: McpEffectiveServer,
    ui: McpLoginUi,
  ) => Effect.Effect<McpAuthStatus, McpBoundaryError>;
  /** Caller revokes connection and result authority before this storage operation. */
  readonly logout: (server: McpEffectiveServer) => Effect.Effect<void, McpBoundaryError>;
  readonly revoke: Effect.Effect<void>;
}
