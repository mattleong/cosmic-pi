import * as Effect from "effect/Effect";
import type { CrossProcessLease } from "pi-cosmic-core";
import type { McpCredentialMutation } from "../auth/progress.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";

export interface KeychainEntry {
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
  /** Local/OS-lock admission only, separate from the native operation budget. Defaults to 15s. */
  readonly acquireTimeoutMs?: number;
  /** Private directory override for child-process tests, never derived from agentDir. */
  readonly lockDirectory?: string;
}
export interface KeychainMutationOwner {
  readonly lease?: CrossProcessLease;
  readonly isCurrent?: () => boolean;
  readonly checkCurrent?: Effect.Effect<void, McpBoundaryError>;
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
// Native completion ownership outlives an interrupted Effect waiter. No AbortSignal is
// passed to napi: cancellation of its Promise would not establish native completion.
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
    const read = (identity: string, owner?: KeychainMutationOwner) =>
      Effect.suspend(() => {
        const fence = fenceFor(identity);
        if (!validIdentity(identity)) return Effect.fail(unavailable());
        if (fence.blocked || fence.pending) return Effect.fail(unresolved());
        const revision = fence.revision;
        return Effect.gen(function* () {
          const entry = yield* Effect.tryPromise({
            try: () => factory(service, identity),
            catch: unavailable,
          });
          // The factory may await keyring import or a native entry. Recheck full config
          // authority in Effect after that wait, not just the synchronous trust predicate.
          yield* owner?.checkCurrent ?? Effect.void;
          return yield* Effect.tryPromise({
            try: (signal) => {
              const current = () =>
                !signal.aborted &&
                owner?.isCurrent?.() !== false &&
                !fence.blocked &&
                !fence.pending &&
                fence.revision === revision;
              if (!current()) throw unavailable();
              return entry.getPassword().then((value) => {
                if (!current()) throw unavailable();
                return value ?? undefined;
              });
            },
            catch: unavailable,
          });
        }).pipe(
          Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(unavailable()) }),
        );
      });
    const mutate = (identity: string, password?: string, owner?: KeychainMutationOwner) =>
      Effect.suspend(() => {
        if (!validIdentity(identity)) return Effect.fail(unavailable());
        const fence = fenceFor(identity);
        const removing = password === undefined;
        const error = removing ? deletionFailed : unavailable;
        if (!removing && (fence.blocked || fence.pending)) return Effect.fail(unresolved());
        const predecessor = fence.pending;
        fence.blocked = true;
        const revision = ++fence.revision;
        return Effect.gen(function* () {
          if (predecessor) yield* Effect.tryPromise({ try: () => predecessor, catch: error });
          const entry = yield* Effect.tryPromise({
            try: () => factory(service, identity),
            catch: error,
          });
          yield* owner?.checkCurrent ?? Effect.void;
          return yield* Effect.tryPromise({
            try: (signal) => {
              if (signal.aborted || owner?.isCurrent?.() === false || fence.revision !== revision)
                throw error();
              // Durable journal before native admission; no asynchronous work between them.
              owner?.lease?.mutationStarted();
              const completion = Promise.withResolvers<void>();
              fence.pending = completion.promise;
              let interrupted: boolean = signal.aborted;
              const abort = () => {
                interrupted = true;
                fence.blocked = true;
              };
              signal.addEventListener("abort", abort, { once: true });
              let native: Promise<void>;
              try {
                native = removing
                  ? entry.deleteCredential().then(() => undefined)
                  : entry.setPassword(password);
              } catch {
                // A throwing foreign API may already have dispatched. Retain pending journal.
                signal.removeEventListener("abort", abort);
                throw error();
              }
              return native
                .then(
                  () => {
                    owner?.lease?.mutationSettled();
                    if (fence.pending === completion.promise) fence.pending = undefined;
                    if (fence.revision === revision) fence.blocked = interrupted;
                    completion.resolve();
                    if (interrupted) throw error();
                  },
                  () => {
                    owner?.lease?.mutationSettled();
                    if (fence.pending === completion.promise) fence.pending = undefined;
                    fence.blocked = true;
                    completion.resolve();
                    throw error();
                  },
                )
                .finally(() => signal.removeEventListener("abort", abort));
            },
            catch: error,
          });
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(removing ? deletionFailed() : unresolved()),
          }),
        );
      });
    return {
      /** Passive process-local evidence. Never loads keyring or joins a Promise. */
      mutation: (identity: string): Effect.Effect<McpCredentialMutation> =>
        Effect.sync(() => {
          const fence = ownedRecords.get(`${service}\u0000${identity}`);
          return fence?.pending ? "pending" : fence?.blocked ? "blocked" : "idle";
        }),
      read,
      write: (identity: string, password: string, owner?: KeychainMutationOwner) =>
        mutate(identity, password, owner),
      remove: (identity: string, owner?: KeychainMutationOwner) =>
        mutate(identity, undefined, owner),
    };
  });
