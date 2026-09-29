import type * as Effect from "effect/Effect";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import type { McpAuthProgressEvent } from "./progress.ts";
import type { McpGrant, McpRegistrationReceipt } from "./credentials.ts";

/** Private, untrusted transport evidence. Never serialize it into errors or public status. */
export interface McpAuthChallenge {
  readonly wwwAuthenticate: string;
  readonly status: 401 | 403;
}
export interface McpAuthRejection {
  readonly credentialUsed: boolean;
  readonly error?: McpBoundaryError;
}
export interface McpScopeProposal {
  readonly requested: ReadonlyArray<string>;
  readonly additions: ReadonlyArray<string>;
  readonly source: "configured" | "challenge" | "resource-metadata";
}
export interface McpLoginOptions {
  readonly challenge?: McpAuthChallenge;
  readonly previousGrant?: McpGrant;
  readonly registration?: McpRegistrationReceipt;
  readonly saveRegistration?: (
    registration: McpRegistrationReceipt,
  ) => Effect.Effect<void, McpBoundaryError>;
  /** A reused client this session saw rejected; registration skips it and starts fresh. */
  readonly staleClientId?: string;
  /** Forget a reused client the server rejected or whose sign-in was abandoned. */
  readonly forgetRegistration?: (clientId: string) => Effect.Effect<void, McpBoundaryError>;
}

/** User command capability. Never accepted by gateway or Code Mode parameters. */
export interface McpLoginUi {
  readonly mode: "local" | "manual";
  /** Explicit user approval of this immutable permission proposal, not future expansion. */
  readonly approveScopes?: (
    proposal: McpScopeProposal,
    deadline: number,
  ) => Effect.Effect<boolean, McpBoundaryError>;
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
  /** No interactive fallback. requireGrant is for an explicit user check, never a gateway parameter. */
  readonly access: (
    server: McpEffectiveServer,
    options?: { readonly requireGrant?: boolean },
  ) => Effect.Effect<string | undefined, McpBoundaryError>;
  readonly status: (server: McpEffectiveServer) => Effect.Effect<McpAuthStatus>;
  readonly login: (
    server: McpEffectiveServer,
    ui: McpLoginUi,
  ) => Effect.Effect<McpAuthStatus, McpBoundaryError>;
  /** Caller revokes connection and result authority before this storage operation. */
  readonly logout: (server: McpEffectiveServer) => Effect.Effect<void, McpBoundaryError>;
  /** Only a current connection owner may report auth-specific transport rejection. */
  readonly reject: (server: McpEffectiveServer, evidence?: McpAuthRejection) => Effect.Effect<void>;
  /** Execution publishes this only under its still-current outer auth fence authority. */
  readonly finishLogin: (
    server: McpEffectiveServer,
    receipt: McpAuthStatus,
    succeeded: boolean,
  ) => Effect.Effect<void>;
  readonly revoke: Effect.Effect<void>;
}
