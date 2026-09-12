import * as Effect from "effect/Effect";
import type { McpCredentialTransaction } from "./credential-transaction.ts";
import type { McpSdkAuthContract } from "../boundary/sdk-auth.ts";
import { boundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import { AuthRequestCurrent, type AuthAuthority, type AuthBlock } from "./authority.ts";
import type { McpGrant } from "./credentials.ts";
import { authFailure } from "./policy.ts";

/** Caller holds the identity permit through persistence, refresh, and token validation. */
export const refreshGrant = (
  server: McpEffectiveServer,
  grant: McpGrant,
  authority: AuthAuthority,
  current: () => boolean,
  store: McpCredentialTransaction,
  sdk: McpSdkAuthContract,
) =>
  Effect.gen(function* () {
    const owner: AuthBlock = { kind: "refresh" };
    const owned = () => current() && authority.blocked === owner;
    const stale = () => boundaryError("stale", "not-sent", "OAuth operation was revoked.");
    if (!current()) return yield* stale();
    if (authority.blocked) return yield* authFailure();
    // Never reuse this refresh token after entering consumption, including cancellation
    // or a failed native save. Only this exact owner can clear its local block.
    authority.blocked = owner;
    yield* store.write({ ...grant, quarantine: "refresh" });
    if (!owned()) return yield* stale();
    yield* yield* AuthRequestCurrent;
    const refreshed = yield* sdk.refresh(server, grant);
    if (!owned()) return yield* stale();
    if (refreshed.quarantine !== undefined) return yield* authFailure();
    const token = yield* sdk.token(server, refreshed);
    if (!owned()) return yield* stale();
    // Native waiting is interruptible. Durable replacement and exact-owner publication
    // commit together, so cancellation cannot lose the consumption evidence.
    yield* Effect.uninterruptibleMask((restore) =>
      restore(store.write(refreshed)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (owned()) authority.blocked = undefined;
          }),
        ),
      ),
    );
    if (!current() || authority.blocked !== undefined) return yield* stale();
    return token;
  });
