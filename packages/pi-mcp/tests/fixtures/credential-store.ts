import * as Effect from "effect/Effect";
import type { McpCredentialStoreContract } from "../../src/boundary/credential-store.ts";
import { boundaryError } from "../../src/client/errors.ts";

/** In-memory owned boundary adapter. Cross-process tests use the actual credential-store Layer. */
export const transactionStore = (
  store: Omit<McpCredentialStoreContract, "withTransaction">,
): McpCredentialStoreContract => ({
  ...store,
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
