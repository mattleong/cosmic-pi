import * as Effect from "effect/Effect";
import type { McpCredentialMutation } from "../auth/progress.ts";
import { boundaryError } from "../client/errors.ts";

export interface KeychainEntry {
  /** The native implementation can return null despite its optional-string declaration. */
  readonly getPassword: () => Promise<string | null | undefined>;
  readonly setPassword: (password: string) => Promise<void>;
  readonly deleteCredential: () => Promise<boolean>;
}
export type KeychainEntryFactory = (service: string, identity: string) => Promise<KeychainEntry>;
export interface KeychainOptions {
  /** Inject only at an owned platform test boundary. Production never falls back. */
  readonly entryFactory?: KeychainEntryFactory;
  readonly service?: string;
  readonly timeoutMs?: number;
}
const nativeEntry: KeychainEntryFactory = (service, identity) => {
  if (process.platform !== "darwin") return Promise.reject(new Error("Keychain is unavailable."));
  return import("@napi-rs/keyring").then(({ AsyncEntry }) => new AsyncEntry(service, identity));
};
interface Fence {
  pending?: Promise<void> | undefined;
  blocked: boolean;
  revision: number;
}
// Native writes cannot be reliably cancelled. This record outlives Effect scopes.
// Never pass an AbortSignal to napi writes: an aborted Promise is not native completion.
const fences = new WeakMap<KeychainEntryFactory, Map<string, Fence>>();
const unavailable = () =>
  boundaryError(
    "unavailable",
    "not-sent",
    "macOS Keychain is unavailable.",
    "oauth-storage-unavailable",
  );
const unresolved = () =>
  boundaryError(
    "unavailable",
    "not-sent",
    "A credential mutation is unresolved.",
    "oauth-mutation-unresolved",
  );
const deletionFailed = () =>
  boundaryError(
    "cleanup",
    "not-sent",
    "OAuth credentials could not be removed from macOS Keychain.",
    "oauth-deletion-failed",
  );

export const makeKeychainStore = (options: KeychainOptions = {}) =>
  Effect.sync(() => {
    const factory = options.entryFactory ?? nativeEntry;
    const service = options.service ?? "com.cosmic-pi.mcp.oauth.v1";
    let records = fences.get(factory);
    if (!records) {
      records = new Map();
      fences.set(factory, records);
    }
    const ownedRecords = records;
    const fenceFor = (identity: string) => {
      const key = `${service}\u0000${identity}`;
      let fence = ownedRecords.get(key);
      if (!fence) {
        fence = { blocked: false, revision: 0 };
        ownedRecords.set(key, fence);
      }
      return fence;
    };
    const validIdentity = (identity: string) => /^[a-f0-9]{64}$/.test(identity);
    const timeout = options.timeoutMs ?? 15_000;
    const read = (identity: string) =>
      Effect.suspend(() => {
        const fence = fenceFor(identity);
        if (!validIdentity(identity)) return Effect.fail(unavailable());
        if (fence.blocked || fence.pending) return Effect.fail(unresolved());
        const revision = fence.revision;
        return Effect.tryPromise({
          try: (signal) =>
            factory(service, identity)
              .then((entry) => {
                if (signal.aborted || fence.blocked || fence.pending) throw unavailable();
                return entry.getPassword();
              })
              .then((value) => {
                if (fence.blocked || fence.pending || fence.revision !== revision)
                  throw unavailable();
                return value ?? undefined;
              }),
          catch: unavailable,
        }).pipe(
          Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(unavailable()) }),
        );
      });
    const mutate = (identity: string, password?: string) =>
      Effect.suspend(() => {
        if (!validIdentity(identity)) return Effect.fail(unavailable());
        const fence = fenceFor(identity);
        const removing = password === undefined;
        const error = removing ? deletionFailed : unavailable;
        if (!removing && (fence.blocked || fence.pending)) return Effect.fail(unresolved());
        return Effect.tryPromise({
          try: (signal) => {
            const predecessor = fence.pending;
            // Revocation is synchronous and precedes joining an older native write.
            fence.blocked = true;
            fence.revision++;
            let interrupted = signal.aborted;
            const abort = () => {
              interrupted = true;
              fence.blocked = true;
            };
            signal.addEventListener("abort", abort, { once: true });
            const operation = (predecessor ?? Promise.resolve())
              .then(() => {
                if (signal.aborted) throw error();
                return factory(service, identity);
              })
              .then((entry) => {
                if (signal.aborted) throw error();
                return removing
                  ? entry.deleteCredential().then(() => undefined)
                  : entry.setPassword(password);
              });
            // Always resolves, but only after the native operation actually settles.
            const completion = operation.then(
              () => undefined,
              () => undefined,
            );
            fence.pending = completion;
            return operation
              .then(
                () => {
                  if (fence.pending === completion) {
                    fence.pending = undefined;
                    fence.blocked = interrupted;
                  }
                  if (interrupted) throw error();
                },
                () => {
                  if (fence.pending === completion) fence.pending = undefined;
                  fence.blocked = true;
                  throw error();
                },
              )
              .finally(() => signal.removeEventListener("abort", abort));
          },
          catch: error,
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(removing ? deletionFailed() : unresolved()),
          }),
        );
      });
    return {
      /** Passive process-local evidence. Does not load keyring, create an entry, or join a Promise. */
      mutation: (identity: string): Effect.Effect<McpCredentialMutation> =>
        Effect.sync(() => {
          const fence = ownedRecords.get(`${service}\u0000${identity}`);
          return fence?.pending ? "pending" : fence?.blocked ? "blocked" : "idle";
        }),
      read,
      write: (identity: string, password: string) => mutate(identity, password),
      remove: (identity: string) => mutate(identity),
    };
  });
