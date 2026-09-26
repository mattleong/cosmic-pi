import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpReply } from "../client/model.ts";
import type { McpDataRequest, McpGatewayExecution, McpProjectionOptions } from "../tools/model.ts";

/** Callers must reserve this allowance before dispatching a remote operation. */
export const MCP_MIN_PROJECTION_BYTES = 512;
export const MCP_RESULT_LIMITS = Object.freeze({
  acceptedBytes: 8 * 1024 * 1024,
  retainedBytes: 64 * 1024 * 1024,
  entries: 32,
  lines: 2_000,
  nodes: 100_000,
  depth: 64,
  attachments: 128,
  nativeImages: 8,
  imagePixels: 40_000_000,
});

export interface McpPrepareInput {
  readonly owner: string;
  readonly server: string;
  readonly action: string;
  readonly reply: Pick<McpReply, "outcome" | "result">;
  readonly notices?: ReadonlyArray<string>;
  readonly outputValidation?: "failed" | "passed" | "unavailable";
}

export interface McpResultOrigin {
  readonly action: string;
  readonly outcome: "completed";
  readonly isError: boolean;
  readonly outputValidation?: "failed" | "passed" | "unavailable";
}

export interface McpAttachment {
  readonly index: number;
  readonly kind: "image" | "audio" | "resource" | "link" | "unsupported";
  readonly mimeType?: string;
  readonly bytes?: number;
  readonly uri?: string;
  readonly supported: boolean;
}

export interface McpStoredImage {
  readonly index: number;
  readonly mimeType: string;
  readonly data: string;
}

/** Private normalized state. Only projected envelopes may cross the host boundary. */
export interface McpNormalizedResult {
  readonly origin: McpResultOrigin;
  readonly serialized: string;
  readonly attachments: ReadonlyArray<McpAttachment>;
  readonly images: ReadonlyArray<McpStoredImage>;
  readonly notices: ReadonlyArray<string>;
  readonly bytes: number;
  readonly outputLimited: boolean;
}

export interface McpPreparedResult extends McpNormalizedResult {
  readonly owner: string;
  readonly server: string;
  readonly activation: object;
  readonly generation: number;
  readonly candidateId?: string;
}

export type McpRetentionOutcome =
  | { readonly status: "retained"; readonly resultId: string }
  | {
      readonly status: "unretained";
      readonly reason: "capacity" | "output-limit" | "unavailable" | "revoked";
    };

export interface McpResultsOptions {
  /** Test/configuration seams may lower, but never raise, the production limits. */
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export type McpResultRead = Extract<McpDataRequest, { readonly action: "result.read" }>;
export type McpResultAuthorize = (
  owner: string,
  server: string,
) => Effect.Effect<void, McpBoundaryError>;

export interface McpResultsContract {
  readonly prepare: (input: McpPrepareInput) => Effect.Effect<McpPreparedResult, McpBoundaryError>;
  /** No remote work, allocation of payload copies, or fallible callbacks in this commit. */
  readonly retain: (prepared: McpPreparedResult) => Effect.Effect<McpRetentionOutcome>;
  readonly project: (
    prepared: McpPreparedResult,
    retention: McpRetentionOutcome,
    options: McpProjectionOptions,
  ) => Effect.Effect<McpGatewayExecution, McpBoundaryError>;
  readonly read: (
    input: McpResultRead,
    options: McpProjectionOptions,
    authorize: McpResultAuthorize,
  ) => Effect.Effect<McpGatewayExecution, McpBoundaryError>;
  readonly revoke: () => Effect.Effect<void>;
  /** Synchronous withdrawal signal after a committed store change; reads never signal. */
  readonly subscribeChanges: (listener: () => void) => Effect.Effect<void, never, Scope.Scope>;
}

export const originJson = (origin: McpResultOrigin): Schema.Json => ({ ...origin });
