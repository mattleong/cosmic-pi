import type * as Effect from "effect/Effect";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import type { McpAuthProgressEvent } from "./progress.ts";

/** User command capability. Never accepted by gateway or Code Mode parameters. */
export interface McpLoginUi {
  readonly mode: "local" | "manual";
  /** The private guard is rechecked synchronously at the native launch boundary. */
  readonly openBrowser: (
    url: string,
    current?: () => boolean,
  ) => Effect.Effect<void, McpBoundaryError>;
  readonly readCallback: (
    authorizationUrl: string,
    deadline?: number,
  ) => Effect.Effect<string | undefined, McpBoundaryError>;
  /** Stock local-RPC actions. Manual callbacks and TUI panels do not compete with this dialog. */
  readonly nextAction?: (
    deadline: number,
    browserFailed: boolean,
  ) => Effect.Effect<"reopen" | "cancel", McpBoundaryError>;
  /** Optional presentation observer; never creates authentication authority. */
  readonly progress?: (event: McpAuthProgressEvent) => Effect.Effect<void>;
  /** Private attempt-owned handoff. No URL or callback enters a public snapshot. */
  readonly waitForCallback?: (
    authorizationUrl: string,
    deadline: number,
    receive: Effect.Effect<string | undefined, McpBoundaryError>,
  ) => Effect.Effect<string | undefined, McpBoundaryError>;
}
export interface McpAuthStatus {
  readonly state: "none" | "unchecked" | "ready" | "required" | "unavailable";
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
  /** Only a current connection owner may report auth-specific transport rejection. */
  readonly reject: (server: McpEffectiveServer) => Effect.Effect<void>;
  /** Execution publishes these only under its still-current outer auth fence authority. */
  readonly completeLogin: (
    server: McpEffectiveServer,
    receipt: McpAuthStatus,
  ) => Effect.Effect<void>;
  readonly finalizationFailed: (
    server: McpEffectiveServer,
    receipt: McpAuthStatus,
  ) => Effect.Effect<void>;
  readonly revoke: Effect.Effect<void>;
}
