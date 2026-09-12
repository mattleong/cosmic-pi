import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import type { McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";

export interface McpAuthLiveAuthority {
  readonly check: (server: McpEffectiveServer) => Effect.Effect<void, McpBoundaryError>;
  /** Must contain throwing/absent host trust as false. Used immediately before native dispatch. */
  readonly isTrusted: () => boolean;
}
/** Auth service supplies this to every SDK operation; owned SDK unit tests may omit it. */
export const AuthRequestCurrent = Context.Reference<Effect.Effect<void, McpBoundaryError>>(
  "pi-mcp/auth/RequestCurrent",
  { defaultValue: () => Effect.void },
);
import * as Semaphore from "effect/Semaphore";

export interface AuthBlock {
  readonly kind: "refresh" | "rejected" | "logout";
  readonly reason?: "oauth-insufficient-scope";
}
export interface AuthAuthority {
  readonly permit: Semaphore.Semaphore;
  generation: number;
  evidenceRevision: number;
  blocked: AuthBlock | undefined;
  revoked: Deferred.Deferred<void>;
}
// Session revocation and observations are process-local. Credential transactions use
// the separate OS-user CrossProcessLock before reading or mutating Keychain.
const authorities = new Map<string, AuthAuthority>();
export const authorityFor = (identity: string): AuthAuthority => {
  let value = authorities.get(identity);
  if (!value) {
    value = {
      permit: Semaphore.makeUnsafe(1),
      generation: 0,
      evidenceRevision: 0,
      blocked: undefined,
      revoked: Deferred.makeUnsafe<void>(),
    };
    authorities.set(identity, value);
  }
  return value;
};
