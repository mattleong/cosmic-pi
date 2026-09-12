import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { McpBoundaryError } from "../client/errors.ts";

export type McpConfigScope = "global" | "project";
export interface McpOAuthConfig {
  readonly type: "oauth";
  /** Internal default for headerless URL servers; anonymous until challenged or checked by the user. */
  readonly implicit?: true;
  readonly registration: "pre-registered" | "dynamic" | "metadata";
  readonly clientId?: string;
  readonly clientMetadataUrl?: string;
  readonly issuer?: string;
  readonly allowMissingResourceMetadata?: boolean;
  readonly resource?: string;
  readonly scopes: ReadonlyArray<string>;
  /** Distinguishes configured [] from omission without changing other credential identities. */
  readonly explicitEmptyScopes?: true;
  readonly redirectUri?: string;
}
export type McpHttpAuth =
  | { readonly type: "none" }
  | { readonly type: "env"; readonly env: string }
  | McpOAuthConfig;
interface ToolPolicy {
  /** Omission selects modern-first SDK negotiation. */
  readonly protocol?: "auto" | "legacy";
  readonly allowTools?: ReadonlyArray<string>;
  readonly denyTools: ReadonlyArray<string>;
}
export type McpServerDefinition = ToolPolicy &
  (
    | {
        readonly transport: "stdio";
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly cwd?: string;
        readonly environment: Readonly<Record<string, string>>;
      }
    | {
        readonly transport: "http";
        readonly url: string;
        readonly headers: Readonly<Record<string, string>>;
        readonly auth: McpHttpAuth;
      }
  );
export interface McpEffectiveServer {
  readonly id: string;
  readonly scope: McpConfigScope;
  readonly directory: string;
  /** Hash of owning scope and complete effective definition, never resolved credentials. */
  readonly identity: string;
  readonly enabled: boolean;
  readonly definition?: McpServerDefinition;
  readonly diagnostic?: string;
}
export interface McpSettings {
  readonly enabled: boolean;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxConcurrent: number;
  readonly maxPerServer: number;
  readonly maxQueued: number;
}
export interface McpResolvedConfig {
  readonly revision: number;
  readonly trusted: boolean;
  readonly settings: McpSettings;
  readonly servers: Readonly<Record<string, McpEffectiveServer>>;
  readonly diagnostics: ReadonlyArray<string>;
}
export interface McpConfigStoreContract {
  readonly snapshot: Effect.Effect<McpResolvedConfig>;
  /** One current execution owner; publication runs inside each persistence commit. */
  readonly subscribe: (
    publish: (config: McpResolvedConfig) => Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly reload: Effect.Effect<McpResolvedConfig, McpBoundaryError>;
  readonly setServer: (
    scope: McpConfigScope,
    id: string,
    value: Schema.Json,
  ) => Effect.Effect<McpResolvedConfig, McpBoundaryError>;
  readonly removeServer: (
    scope: McpConfigScope,
    id: string,
  ) => Effect.Effect<McpResolvedConfig, McpBoundaryError>;
  readonly setSettings: (
    scope: McpConfigScope,
    value: Schema.Json,
  ) => Effect.Effect<McpResolvedConfig, McpBoundaryError>;
}
