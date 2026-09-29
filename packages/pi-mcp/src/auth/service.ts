import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { hasControlCharacter, NetworkAddresses } from "pi-cosmic-core";
import { McpCredentialStore } from "../boundary/credential-store.ts";
import type { KeychainOptions } from "../boundary/keychain.ts";
import { McpSdkAuth } from "../boundary/sdk-auth.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import type { McpAuthChallenge, McpAuthContract, McpAuthStatus, McpLoginOptions } from "./model.ts";
import {
  AuthRequestCurrent,
  authorityFor,
  withCredentialPermit,
  type AuthBlock,
  type McpAuthLiveAuthority,
} from "./authority.ts";
import { getAuthChallenge } from "./challenge.ts";
import { hasRefreshToken, type McpRegistrationReceipt } from "./credentials.ts";
import { refreshGrant } from "./refresh.ts";
import { withAuthFailureReason } from "./diagnostics.ts";
import {
  authCommandFailure,
  authFailure,
  oauthConfig,
  requireSecureBearerDestination,
} from "./policy.ts";
import { authProgress } from "./progress.ts";

const stale = () => boundaryError("stale", "not-sent", "OAuth operation was revoked.");
const blockedFailure = (block: AuthBlock): McpBoundaryError => {
  if (block.kind === "logout") return authFailure();
  if (block.kind === "refresh")
    return boundaryError(
      "auth-required",
      "not-sent",
      "OAuth refresh requires a new sign-in.",
      "oauth-refresh-unresolved",
    );
  return boundaryError(
    "auth-required",
    "not-sent",
    "The stored OAuth credential was rejected.",
    block.reason ?? "oauth-token-rejected",
  );
};
const envToken = (name: string) =>
  Config.nonEmptyString(name).pipe(
    Effect.mapError(authFailure),
    Effect.filterOrFail(
      (token) => token.length <= 32768 && !hasControlCharacter(token) && !/\s/.test(token),
      authFailure,
    ),
  );

export const makeMcpAuthWithAuthority = (
  live: McpAuthLiveAuthority,
  lockOptions: Pick<KeychainOptions, "acquireTimeoutMs"> = {},
) =>
  Effect.gen(function* () {
    const store = yield* McpCredentialStore;
    const sdk = yield* McpSdkAuth;
    let disposed = false;
    let sessionGeneration = 0;
    let revoked = Deferred.makeUnsafe<void>();
    const observed = new Map<string, McpAuthStatus>();
    const challenges = new Map<string, McpAuthChallenge>();
    const pendingLogins = new Map<
      string,
      {
        readonly status: McpAuthStatus;
        readonly session: number;
        readonly generation: number;
        readonly evidence: number;
      }
    >();
    const revoke = Effect.sync(() => {
      sessionGeneration++;
      const previous = revoked;
      revoked = Deferred.makeUnsafe<void>();
      observed.clear();
      pendingLogins.clear();
      challenges.clear();
      Deferred.doneUnsafe(previous, Effect.void);
    });
    yield* Effect.addFinalizer(() =>
      Effect.andThen(
        revoke,
        Effect.sync(() => {
          disposed = true;
        }),
      ),
    );
    const checkServer = (server: McpEffectiveServer) =>
      Effect.suspend(() =>
        !disposed && live.isTrusted() && server.enabled && server.definition
          ? live.check(server)
          : Effect.fail(stale()),
      );
    const captureAuthority = (server: McpEffectiveServer) => {
      const authority = authorityFor(server.credentialIdentity);
      const generation = authority.generation;
      const session = sessionGeneration;
      const evidence = authority.evidenceRevision;
      const current = () =>
        !disposed &&
        live.isTrusted() &&
        sessionGeneration === session &&
        authority.generation === generation &&
        authority.evidenceRevision === evidence;
      return { authority, generation, session, evidence, current };
    };
    const owned = <A>(
      server: McpEffectiveServer,
      work: Effect.Effect<A, McpBoundaryError>,
      publishReady = true,
    ) =>
      Effect.suspend(() => {
        const signal = revoked;
        const { authority, current } = captureAuthority(server);
        const serverSignal = authority.revoked;
        const check = Effect.andThen(
          checkServer(server),
          Effect.suspend(() => (current() ? Effect.void : Effect.fail(stale()))),
        );
        const monitor = Effect.forever(Effect.andThen(Effect.sleep(50), check));
        const cancelled = Effect.raceFirst(Deferred.await(signal), Deferred.await(serverSignal));
        return Effect.raceFirst(
          Effect.raceFirst(Effect.andThen(check, work), monitor),
          cancelled.pipe(Effect.andThen(Effect.fail(stale()))),
        ).pipe(
          Effect.provideService(AuthRequestCurrent, check),
          Effect.tap(() => check),
          Effect.filterOrFail(() => current(), stale),
          Effect.mapError((error) => withAuthFailureReason(server, error)),
          Effect.tap(() =>
            Effect.sync(() => {
              if (current() && publishReady)
                observed.set(server.credentialIdentity, { state: "ready" });
            }),
          ),
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (
                current() &&
                error.kind !== "cancelled" &&
                error.kind !== "stale" &&
                error.reason !== "auth-env-sign-in-unsupported"
              )
                observed.set(server.credentialIdentity, {
                  state: error.kind === "auth-required" ? "required" : "unavailable",
                });
            }),
          ),
        );
      });
    const access: McpAuthContract["access"] = (server, options) =>
      Effect.suspend(() => {
        const anonymous =
          oauthConfig(server)?.implicit === true &&
          options?.requireGrant !== true &&
          !observed.has(server.credentialIdentity) &&
          !authorityFor(server.credentialIdentity).blocked;
        return owned(
          server,
          Effect.gen(function* () {
            yield* checkServer(server);
            const definition = server.definition!;
            if (definition.transport === "stdio" || definition.auth.type === "none")
              return undefined;
            if (definition.auth.type === "env") {
              yield* requireSecureBearerDestination(definition.url);
              yield* checkServer(server);
              const token = yield* envToken(definition.auth.env);
              yield* checkServer(server);
              return token;
            }
            if (anonymous) return undefined;
            const { authority, current } = captureAuthority(server);
            return yield* store
              .withTransaction(
                server.credentialIdentity,
                (tx) =>
                  Effect.gen(function* () {
                    if (!current()) return yield* stale();
                    const block = authority.blocked;
                    if (block && !block.recover) return yield* blockedFailure(block);
                    const grant = yield* tx.read;
                    yield* checkServer(server);
                    if (!current() || authority.blocked !== block) return yield* stale();
                    if (!grant) return yield* authFailure();
                    if (grant.quarantine !== undefined) {
                      authority.blocked = { kind: "refresh" };
                      return yield* blockedFailure(authority.blocked);
                    }
                    const now = yield* Clock.currentTimeMillis;
                    if (block?.recover) {
                      // The server rejected an unexpired token. Refresh once for the next
                      // request; the rejected operation itself is never replayed.
                      authority.blocked = undefined;
                      authority.recoveredAt = now;
                      return yield* refreshGrant(server, grant, authority, current, tx, sdk);
                    }
                    if (grant.expiresAt !== undefined && grant.expiresAt <= now + 30_000)
                      return yield* refreshGrant(server, grant, authority, current, tx, sdk);
                    const token = yield* sdk.token(server, grant);
                    if (!current() || authority.blocked) return yield* stale();
                    yield* checkServer(server);
                    authority.refreshable = hasRefreshToken(grant);
                    return token;
                  }),
                { checkCurrent: checkServer(server), isCurrent: current },
              )
              .pipe((work) =>
                withCredentialPermit(authority.permit, work, checkServer(server), lockOptions),
              );
          }),
          !anonymous,
        );
      });
    const login: McpAuthContract["login"] = (server, ui) =>
      owned(
        server,
        Effect.gen(function* () {
          yield* checkServer(server);
          const failure = authCommandFailure(server, "login");
          if (failure) return yield* failure;
          pendingLogins.delete(server.credentialIdentity);
          const { authority, generation, session, evidence, current } = captureAuthority(server);
          return yield* store
            .withTransaction(
              server.credentialIdentity,
              (tx) =>
                Effect.gen(function* () {
                  if (!current()) return yield* stale();
                  // Probe secure storage before starting a browser or sending registration traffic.
                  yield* authProgress(ui, { phase: "storage" });
                  const previousGrant = yield* tx.read;
                  const registration = yield* tx.readRegistration;
                  if (!current()) return yield* stale();
                  let registering = true;
                  const saveRegistration = (receipt: McpRegistrationReceipt) =>
                    Effect.gen(function* () {
                      if (!registering || !current()) return yield* stale();
                      // Login already holds the identity permit. This checkpoint preserves the
                      // old grant and never publishes credential-save or readiness evidence.
                      yield* tx.writeRegistration(receipt);
                      if (!registering || !current()) return yield* stale();
                    });
                  const challenge = challenges.get(server.credentialIdentity);
                  let options: McpLoginOptions = { saveRegistration };
                  if (previousGrant) options = { ...options, previousGrant };
                  if (registration) options = { ...options, registration };
                  if (challenge) options = { ...options, challenge };
                  const grant = yield* sdk.login(server, ui, options).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        registering = false;
                      }),
                    ),
                  );
                  if (!current()) return yield* stale();
                  if (grant.quarantine !== undefined) return yield* authFailure();
                  yield* authProgress(ui, { phase: "saving" });
                  const status: McpAuthStatus = Object.freeze({ state: "ready" });
                  let saved = false;
                  // The native wait stays interruptible. A confirmed write and its local
                  // receipt commit together before cancellation can lose that evidence.
                  yield* Effect.uninterruptibleMask((restore) =>
                    restore(tx.write(grant)).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          saved = true;
                          if (!current()) {
                            authority.blocked ??= { kind: "rejected" };
                            return;
                          }
                          authority.blocked = undefined;
                          challenges.delete(server.credentialIdentity);
                          pendingLogins.set(server.credentialIdentity, {
                            status,
                            session,
                            generation,
                            evidence,
                          });
                          observed.set(server.credentialIdentity, { state: "unavailable" });
                        }),
                      ),
                    ),
                  ).pipe(
                    Effect.ensuring(
                      Effect.gen(function* () {
                        if (!current()) authority.blocked ??= { kind: "rejected" };
                        const mutation = yield* store.mutation(server.credentialIdentity);
                        yield* authProgress(ui, {
                          phase: saved ? "finalizing" : "saving",
                          credentialsSaved: saved,
                          mutation,
                        });
                      }),
                    ),
                  );
                  if (!current()) return yield* stale();
                  yield* checkServer(server);
                  return status;
                }),
              { checkCurrent: checkServer(server), isCurrent: current },
            )
            .pipe((work) =>
              withCredentialPermit(authority.permit, work, checkServer(server), lockOptions),
            );
        }),
        false,
      );
    const logout: McpAuthContract["logout"] = (server) =>
      Effect.suspend(() => {
        const failure = authCommandFailure(server, "logout");
        if (failure) return Effect.fail(failure);
        observed.set(server.credentialIdentity, { state: "required" });
        pendingLogins.delete(server.credentialIdentity);
        const authority = authorityFor(server.credentialIdentity);
        authority.generation++;
        authority.blocked = { kind: "logout" };
        challenges.delete(server.credentialIdentity);
        const previous = authority.revoked;
        authority.revoked = Deferred.makeUnsafe<void>();
        Deferred.doneUnsafe(previous, Effect.void);
        // Revoke first, then join the permit and the store's native mutation fence.
        return store
          .withTransaction(server.credentialIdentity, (tx) => tx.remove, {
            checkCurrent: checkServer(server),
            isCurrent: () => !disposed && live.isTrusted(),
          })
          .pipe((work) =>
            withCredentialPermit(authority.permit, work, checkServer(server), lockOptions),
          );
      });
    const status: McpAuthContract["status"] = (server) =>
      Effect.gen(function* () {
        if (disposed || !server.enabled || !server.definition) return { state: "unavailable" };
        if (server.definition.transport === "stdio" || server.definition.auth.type === "none")
          return { state: "none" };
        if (
          server.definition.auth.type === "oauth" &&
          (yield* store.mutation(server.credentialIdentity)) !== "idle"
        )
          return { state: "unavailable" };
        const block = authorityFor(server.credentialIdentity).blocked;
        if (block && !block.recover) return { state: "required" };
        return observed.get(server.credentialIdentity) ?? { state: "unchecked" };
      });
    const reject: McpAuthContract["reject"] = (server, evidence) =>
      Effect.gen(function* () {
        if (disposed) return;
        const now = yield* Clock.currentTimeMillis;
        const authority = authorityFor(server.credentialIdentity);
        const challenge = evidence?.error && getAuthChallenge(evidence.error);
        if (challenge && oauthConfig(server)) challenges.set(server.credentialIdentity, challenge);
        if (evidence?.credentialUsed && oauthConfig(server))
          authority.blocked =
            evidence.error?.reason === "oauth-insufficient-scope"
              ? { kind: "rejected", reason: "oauth-insufficient-scope" }
              : // Refresh recovers revoked or clock-skewed tokens. A second rejection within
                // a minute of that recovery needs a sign-in rather than another refresh.
                authority.refreshable &&
                  (authority.recoveredAt === undefined || now - authority.recoveredAt >= 60_000)
                ? { kind: "rejected", recover: true }
                : { kind: "rejected" };
        authority.evidenceRevision++;
        pendingLogins.delete(server.credentialIdentity);
        if (authority.blocked?.recover) observed.delete(server.credentialIdentity);
        else observed.set(server.credentialIdentity, { state: "required" });
      });
    const finishLogin: McpAuthContract["finishLogin"] = (server, status, succeeded) =>
      Effect.gen(function* () {
        const mutation = yield* store.mutation(server.credentialIdentity);
        const receipt = pendingLogins.get(server.credentialIdentity);
        if (
          !receipt ||
          receipt.status !== status ||
          disposed ||
          receipt.session !== sessionGeneration ||
          receipt.generation !== authorityFor(server.credentialIdentity).generation ||
          receipt.evidence !== authorityFor(server.credentialIdentity).evidenceRevision
        )
          return;
        pendingLogins.delete(server.credentialIdentity);
        observed.set(server.credentialIdentity, {
          state:
            succeeded && mutation === "idle" && !authorityFor(server.credentialIdentity).blocked
              ? "ready"
              : "unavailable",
        });
      });
    return {
      access,
      login,
      logout,
      status,
      revoke,
      reject,
      finishLogin,
    } satisfies McpAuthContract;
  });
/** Owned service tests inject stores and SDK boundaries without a Pi host. */
export const makeMcpAuth = makeMcpAuthWithAuthority({
  check: () => Effect.void,
  isTrusted: () => true,
});
export class McpAuth extends Context.Service<McpAuth, McpAuthContract>()(
  "pi-mcp/auth/service/McpAuth",
) {
  static readonly layer = (options: KeychainOptions, authority: McpAuthLiveAuthority) =>
    Layer.effect(this, makeMcpAuthWithAuthority(authority, options)).pipe(
      Layer.provide(
        Layer.merge(
          McpCredentialStore.layer(options),
          McpSdkAuth.layer.pipe(
            Layer.provide(Layer.merge(NetworkAddresses.layer, NodeCrypto.layer)),
          ),
        ),
      ),
    );
}
