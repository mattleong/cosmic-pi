import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { ExtensionFormOwner, FormOutcome, OwnedFormRequest } from "pi-ask-user/protocol";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpReply } from "../client/model.ts";

export interface McpContinuation {
  readonly inputResponses?: Readonly<Record<string, FormOutcome>>;
  readonly requestState?: string;
}
/** Input-required is private continuation evidence, not a terminal operation result. */
export type McpExchange =
  | { readonly kind: "complete"; readonly reply: McpReply }
  | {
      readonly kind: "input-required";
      readonly inputRequests?: Readonly<Record<string, Schema.Json>>;
      readonly requestState?: string;
      readonly cleanupUnconfirmed?: boolean;
    };
export interface McpInteractionProvider {
  readonly generation: string;
  readonly current: Effect.Effect<boolean>;
  readonly ask: (
    request: OwnedFormRequest,
    owner: ExtensionFormOwner,
  ) => Effect.Effect<FormOutcome, McpBoundaryError>;
  readonly openBrowser: (
    url: string,
    checkCurrent: Effect.Effect<void, McpBoundaryError>,
  ) => Effect.Effect<boolean, McpBoundaryError>;
}
export interface McpInteractionHost {
  readonly resolve: Effect.Effect<McpInteractionProvider | undefined, McpBoundaryError>;
}
export const MCP_INTERACTION_LIMITS = Object.freeze({ rounds: 8, requests: 16, bytes: 64 * 1024 });
