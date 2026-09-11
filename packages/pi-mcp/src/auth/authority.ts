import * as Deferred from "effect/Deferred";
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
// Process-local only. The durable refresh marker also protects sequential restarts;
// this permit does not coordinate separate running processes.
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
