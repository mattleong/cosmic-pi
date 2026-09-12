import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import {
  CrossProcessLock,
  CrossProcessLockError,
  type CrossProcessLockOptions,
} from "pi-cosmic-core";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
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

/** Local and filesystem admission share a deadline, never a credential-operation timeout. */
export const withCredentialPermit = <A>(
  permit: Semaphore.Semaphore,
  work: Effect.Effect<A, McpBoundaryError | CrossProcessLockError>,
  check: Effect.Effect<void, McpBoundaryError>,
  options: CrossProcessLockOptions = {},
): Effect.Effect<A, McpBoundaryError> =>
  CrossProcessLock.withPermit(permit, work, check, options).pipe(
    Effect.mapError((error) => {
      if (!(error instanceof CrossProcessLockError)) return error;
      if (error.reason === "acquire-timeout")
        return boundaryError(
          "timeout",
          "not-sent",
          "Credential coordination admission timed out. The current owner was not changed.",
          "oauth-coordination-timeout",
        );
      return boundaryError(
        "unavailable",
        "not-sent",
        error.reason === "recovery-required"
          ? "Credential ownership requires recovery. Stop all Pi processes and confirm native Keychain operations have settled before removing retained lock evidence. Then sign in again."
          : "Credential coordination is unavailable.",
        "oauth-mutation-unresolved",
      );
    }),
  );

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
