import * as Effect from "effect/Effect";
import type { McpCredentialTransaction } from "../../src/auth/credential-transaction.ts";
import type { McpGrant, McpRegistrationReceipt } from "../../src/auth/credentials.ts";
import type { McpCredentialStoreContract } from "../../src/boundary/credential-store.ts";
import { boundaryError } from "../../src/client/errors.ts";

/** One-shot operations per identity. Production reaches them only through `withTransaction`. */
export interface FlatCredentialStore {
  readonly mutation: McpCredentialStoreContract["mutation"];
  readonly read: (identity: string) => McpCredentialTransaction["read"];
  readonly readRegistration: (identity: string) => McpCredentialTransaction["readRegistration"];
  readonly write: (
    identity: string,
    grant: McpGrant,
  ) => ReturnType<McpCredentialTransaction["write"]>;
  readonly writeRegistration: (
    identity: string,
    registration: McpRegistrationReceipt,
  ) => ReturnType<McpCredentialTransaction["writeRegistration"]>;
  readonly remove: (identity: string) => McpCredentialTransaction["remove"];
}

/** Runs each flat operation as its own transaction on an actual or fake store. */
export const flat = (store: McpCredentialStoreContract): Omit<FlatCredentialStore, "mutation"> => ({
  read: (identity) => store.withTransaction(identity, (tx) => tx.read),
  readRegistration: (identity) => store.withTransaction(identity, (tx) => tx.readRegistration),
  write: (identity, grant) => store.withTransaction(identity, (tx) => tx.write(grant)),
  writeRegistration: (identity, registration) =>
    store.withTransaction(identity, (tx) => tx.writeRegistration(registration)),
  remove: (identity) => store.withTransaction(identity, (tx) => tx.remove),
});

/** In-memory owned boundary adapter. Cross-process tests use the actual credential-store Layer. */
export const transactionStore = (store: FlatCredentialStore): McpCredentialStoreContract => ({
  mutation: store.mutation,
  withTransaction: (identity, use, guard = {}) =>
    Effect.suspend(() => {
      let open = true;
      const check = Effect.andThen(
        guard.checkCurrent ?? Effect.void,
        Effect.suspend(() =>
          open && guard.isCurrent?.() !== false
            ? Effect.void
            : Effect.fail(boundaryError("stale", "not-sent", "Test credential owner was revoked.")),
        ),
      );
      return use({
        read: Effect.andThen(check, store.read(identity)).pipe(Effect.tap(() => check)),
        readRegistration: Effect.andThen(check, store.readRegistration(identity)).pipe(
          Effect.tap(() => check),
        ),
        write: (grant) => Effect.andThen(check, store.write(identity, grant)),
        writeRegistration: (receipt) =>
          Effect.andThen(check, store.writeRegistration(identity, receipt)),
        remove: Effect.andThen(check, store.remove(identity)),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            open = false;
          }),
        ),
      );
    }),
});
