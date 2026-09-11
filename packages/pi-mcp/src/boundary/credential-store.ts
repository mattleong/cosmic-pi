import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import {
  decodeCredentialRecord,
  encodeCredentialRecord,
  type McpCredentialRecord,
} from "../auth/credential-record.ts";
import type { McpGrant, McpRegistrationReceipt } from "../auth/credentials.ts";
import type { McpCredentialMutation } from "../auth/progress.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { makeKeychainStore, type KeychainOptions } from "./keychain.ts";

export interface McpCredentialStoreContract {
  readonly mutation: (identity: string) => Effect.Effect<McpCredentialMutation>;
  readonly readRegistration: (
    identity: string,
  ) => Effect.Effect<McpRegistrationReceipt | undefined, McpBoundaryError>;
  /** Updates the same credential record without discarding an existing grant. */
  readonly writeRegistration: (
    identity: string,
    registration: McpRegistrationReceipt,
  ) => Effect.Effect<void, McpBoundaryError>;
  readonly read: (identity: string) => Effect.Effect<McpGrant | undefined, McpBoundaryError>;
  readonly write: (identity: string, grant: McpGrant) => Effect.Effect<void, McpBoundaryError>;
  /** Joins any native mutation before deleting both the grant and registration. */
  readonly remove: (identity: string) => Effect.Effect<void, McpBoundaryError>;
}
// Serialize envelope read/modify/write across replacement runtimes in this process.
// Native mutation fences remain authoritative after an interrupted waiter releases this lock.
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
        const readRecord = (identity: string) =>
          store.read(identity).pipe(
            Effect.flatMap((raw) =>
              raw === undefined
                ? Effect.succeed<McpCredentialRecord>({ version: 2 })
                : decodeCredentialRecord(raw),
            ),
            Effect.filterOrFail((record) => matches(identity, record), invalid),
          );
        const update = (
          identity: string,
          change: (record: McpCredentialRecord) => McpCredentialRecord,
        ) =>
          Effect.suspend(() =>
            readRecord(identity).pipe(
              Effect.map(change),
              Effect.filterOrFail((record) => matches(identity, record), invalid),
              Effect.flatMap(encodeCredentialRecord),
              Effect.flatMap((raw) => store.write(identity, raw)),
              permitFor(options, identity).withPermits(1),
            ),
          );
        return {
          read: (identity) => readRecord(identity).pipe(Effect.map((record) => record.grant)),
          readRegistration: (identity) =>
            readRecord(identity).pipe(Effect.map((record) => record.registration)),
          write: (identity, grant) => update(identity, (record) => ({ ...record, grant })),
          writeRegistration: (identity, registration) =>
            update(identity, (record) => ({ ...record, registration })),
          remove: (identity) =>
            Effect.suspend(() =>
              store.remove(identity).pipe(permitFor(options, identity).withPermits(1)),
            ),
          mutation: store.mutation,
        } satisfies McpCredentialStoreContract;
      }),
    );
}
