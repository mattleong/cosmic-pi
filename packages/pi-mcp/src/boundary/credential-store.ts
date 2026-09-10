import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { decodeGrant, encodeGrant, type McpGrant } from "../auth/credentials.ts";
import type { McpBoundaryError } from "../client/errors.ts";
import { makeKeychainStore, type KeychainOptions } from "./keychain.ts";

export interface McpCredentialStoreContract {
  readonly read: (identity: string) => Effect.Effect<McpGrant | undefined, McpBoundaryError>;
  readonly write: (identity: string, grant: McpGrant) => Effect.Effect<void, McpBoundaryError>;
  /** Joins any native mutation before deleting. Failure never means removed. */
  readonly remove: (identity: string) => Effect.Effect<void, McpBoundaryError>;
}
export class McpCredentialStore extends Context.Service<
  McpCredentialStore,
  McpCredentialStoreContract
>()("pi-mcp/boundary/credential-store/McpCredentialStore") {
  static readonly layer = (options: KeychainOptions = {}) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const store = yield* makeKeychainStore(options);
        return {
          read: (identity) =>
            store
              .read(identity)
              .pipe(
                Effect.flatMap((raw) =>
                  raw === undefined ? Effect.succeed(undefined) : decodeGrant(raw),
                ),
              ),
          write: (identity, grant) =>
            encodeGrant(grant).pipe(Effect.flatMap((raw) => store.write(identity, raw))),
          remove: store.remove,
        } satisfies McpCredentialStoreContract;
      }),
    );
}
