import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { CrossProcessLock, type CrossProcessLease } from "pi-cosmic-core";
import { withCredentialPermit } from "../auth/authority.ts";
import {
  decodeCredentialRecord,
  encodeCredentialRecord,
  type McpCredentialRecord,
} from "../auth/credential-record.ts";
import type { McpCredentialMutation } from "../auth/progress.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { makeKeychainStore, type KeychainOptions } from "./keychain.ts";

import type {
  CredentialTransactionGuard,
  McpCredentialTransaction,
} from "../auth/credential-transaction.ts";
export interface McpCredentialStoreContract {
  readonly mutation: (identity: string) => Effect.Effect<McpCredentialMutation>;
  /** Acquires ownership before rereading and holds it through the complete callback. */
  readonly withTransaction: <A>(
    identity: string,
    use: (transaction: McpCredentialTransaction) => Effect.Effect<A, McpBoundaryError>,
    guard?: CredentialTransactionGuard,
  ) => Effect.Effect<A, McpBoundaryError>;
}
const nativeNamespace = {};
const locks = new WeakMap<object, Map<string, Semaphore.Semaphore>>();
const permitFor = (options: KeychainOptions, identity: string) => {
  const namespace = options.entryFactory ?? nativeNamespace;
  let records = locks.get(namespace);
  if (!records) {
    records = new Map();
    locks.set(namespace, records);
  }
  const key = `${options.service ?? "com.cosmic-pi.mcp.oauth.v1"}\u0000${identity}`;
  let permit = records.get(key);
  if (!permit) {
    permit = Semaphore.makeUnsafe(1);
    records.set(key, permit);
  }
  return permit;
};
const invalid = () =>
  boundaryError("unavailable", "not-sent", "Stored OAuth credential identity is invalid.");
const stale = () => boundaryError("stale", "not-sent", "Credential transaction was revoked.");
const matches = (identity: string, record: McpCredentialRecord) =>
  (record.grant === undefined || record.grant.identity === identity) &&
  (record.registration === undefined || record.registration.identity === identity);

export class McpCredentialStore extends Context.Service<
  McpCredentialStore,
  McpCredentialStoreContract
>()("pi-mcp/boundary/credential-store/McpCredentialStore") {
  static readonly layer = (options: KeychainOptions = {}) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const store = yield* makeKeychainStore(options);
        const coordinator = yield* CrossProcessLock;
        const withTransaction: McpCredentialStoreContract["withTransaction"] = (
          identity,
          use,
          guard = {},
        ) =>
          Effect.suspend(() => {
            if (!/^[a-f0-9]{64}$/.test(identity)) return Effect.fail(invalid());
            const check = Effect.andThen(
              guard.checkCurrent ?? Effect.void,
              Effect.suspend(() =>
                guard.isCurrent?.() === false ? Effect.fail(stale()) : Effect.void,
              ),
            );
            const run = (lease?: CrossProcessLease) =>
              Effect.suspend(() => {
                let open = true;
                const current = () => open && guard.isCurrent?.() !== false;
                const checked = Effect.andThen(
                  check,
                  Effect.suspend(() => (current() ? Effect.void : Effect.fail(stale()))),
                );
                const owner = { lease, isCurrent: current, checkCurrent: checked };
                const readRecord = Effect.andThen(checked, store.read(identity, owner)).pipe(
                  Effect.flatMap((raw) =>
                    raw === undefined
                      ? Effect.succeed<McpCredentialRecord>({ version: 2 })
                      : decodeCredentialRecord(raw),
                  ),
                  Effect.filterOrFail((record) => matches(identity, record), invalid),
                  Effect.tap(() => checked),
                );
                const update = (change: (record: McpCredentialRecord) => McpCredentialRecord) =>
                  readRecord.pipe(
                    Effect.map(change),
                    Effect.filterOrFail((record) => matches(identity, record), invalid),
                    Effect.flatMap(encodeCredentialRecord),
                    Effect.flatMap((raw) =>
                      Effect.andThen(checked, store.write(identity, raw, owner)),
                    ),
                  );
                return use({
                  read: readRecord.pipe(Effect.map((record) => record.grant)),
                  readRegistration: readRecord.pipe(Effect.map((record) => record.registration)),
                  write: (grant) => update((record) => ({ ...record, grant })),
                  writeRegistration: (registration) =>
                    update((record) => ({ ...record, registration })),
                  remove: Effect.andThen(checked, store.remove(identity, owner)),
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      open = false;
                    }),
                  ),
                );
              });
            // The namespace is the actual native service/account, shared by all agent directories.
            const coordinated =
              options.entryFactory && !options.lockDirectory
                ? run()
                : coordinator.withLock(
                    `keychain\u0000${options.service ?? "com.cosmic-pi.mcp.oauth.v1"}\u0000${identity}`,
                    run,
                    check,
                  );
            return withCredentialPermit(permitFor(options, identity), coordinated, check, options);
          });
        return { withTransaction, mutation: store.mutation } satisfies McpCredentialStoreContract;
      }),
    ).pipe(
      Layer.provide(
        CrossProcessLock.layer(
          options.lockDirectory ? { ...options, directory: options.lockDirectory } : options,
        ),
      ),
    );
}
