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
import { authorityFor, type AuthBlock } from "./authority.ts";
import { getAuthChallenge } from "./challenge.ts";
import type { McpRegistrationReceipt } from "./credentials.ts";
import { refreshGrant } from "./refresh.ts";
import { withAuthFailureReason } from "./diagnostics.ts";
import { authFailure, oauthConfig } from "./policy.ts";
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

export const makeMcpAuth = Effect.gen(function* () {
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
    !disposed && server.enabled && server.definition ? Effect.void : Effect.fail(stale());
  const owned = <A>(
    server: McpEffectiveServer,
    work: Effect.Effect<A, McpBoundaryError>,
    publishReady = true,
  ) =>
    Effect.suspend(() => {
      const signal = revoked;
      const generation = sessionGeneration;
      const authority = authorityFor(server.identity);
      const serverSignal = authority.revoked;
      const serverGeneration = authority.generation;
      const evidence = authority.evidenceRevision;
      const current = () =>
        generation === sessionGeneration &&
        !disposed &&
        serverGeneration === authority.generation &&
        evidence === authority.evidenceRevision;
      const cancelled = Effect.raceFirst(Deferred.await(signal), Deferred.await(serverSignal));
      return Effect.raceFirst(work, cancelled.pipe(Effect.andThen(Effect.fail(stale())))).pipe(
        Effect.filterOrFail(() => current(), stale),
        Effect.mapError((error) => withAuthFailureReason(server, error)),
        Effect.tap(() =>
          Effect.sync(() => {
            if (current() && publishReady) observed.set(server.identity, { state: "ready" });
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
              observed.set(server.identity, {
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
        !observed.has(server.identity) &&
        !authorityFor(server.identity).blocked;
      return owned(
        server,
        Effect.gen(function* () {
          yield* checkServer(server);
          const definition = server.definition!;
          if (definition.transport === "stdio" || definition.auth.type === "none") return undefined;
          if (definition.auth.type === "env") return yield* envToken(definition.auth.env);
          if (anonymous) return undefined;
          const authority = authorityFor(server.identity);
          const generation = authority.generation;
          const session = sessionGeneration;
          const evidence = authority.evidenceRevision;
          const current = () =>
            !disposed &&
            sessionGeneration === session &&
            authority.generation === generation &&
            authority.evidenceRevision === evidence;
          return yield* Effect.gen(function* () {
            if (!current()) return yield* stale();
            if (authority.blocked) return yield* blockedFailure(authority.blocked);
            const grant = yield* store.read(server.identity);
            if (!current() || authority.blocked) return yield* stale();
            if (!grant) return yield* authFailure();
            if (grant.quarantine !== undefined) {
              authority.blocked = { kind: "refresh" };
              return yield* blockedFailure(authority.blocked);
            }
            const now = yield* Clock.currentTimeMillis;
            if (grant.expiresAt !== undefined && grant.expiresAt <= now + 30_000)
              return yield* refreshGrant(server, grant, authority, current, store, sdk);
            const token = yield* sdk.token(server, grant);
            if (!current() || authority.blocked) return yield* stale();
            return token;
          }).pipe(authority.permit.withPermits(1));
        }),
        !anonymous,
      );
    });
  const login: McpAuthContract["login"] = (server, ui) =>
    owned(
      server,
      Effect.gen(function* () {
        yield* checkServer(server);
        if (!oauthConfig(server)) {
          const definition = server.definition;
          if (definition?.transport === "http" && definition.auth.type === "env")
            return yield* boundaryError(
              "unsupported",
              "not-sent",
              "Environment authentication does not support browser sign-in.",
              "auth-env-sign-in-unsupported",
            );
          return yield* authFailure();
        }
        pendingLogins.delete(server.identity);
        const authority = authorityFor(server.identity);
        const generation = authority.generation;
        const session = sessionGeneration;
        const evidence = authority.evidenceRevision;
        const current = () =>
          !disposed &&
          sessionGeneration === session &&
          authority.generation === generation &&
          authority.evidenceRevision === evidence;
        return yield* Effect.gen(function* () {
          if (!current()) return yield* stale();
          // Probe secure storage before starting a browser or sending registration traffic.
          yield* authProgress(ui, { phase: "storage" });
          const previousGrant = yield* store.read(server.identity);
          const registration = yield* store.readRegistration(server.identity);
          if (!current()) return yield* stale();
          let registering = true;
          const saveRegistration = (receipt: McpRegistrationReceipt) =>
            Effect.gen(function* () {
              if (!registering || !current()) return yield* stale();
              // Login already holds the identity permit. This checkpoint preserves the
              // old grant and never publishes credential-save or readiness evidence.
              yield* store.writeRegistration(server.identity, receipt);
              if (!registering || !current()) return yield* stale();
            });
          const challenge = challenges.get(server.identity);
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
            restore(store.write(server.identity, grant)).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  saved = true;
                  if (!current()) {
                    authority.blocked ??= { kind: "rejected" };
                    return;
                  }
                  authority.blocked = undefined;
                  challenges.delete(server.identity);
                  pendingLogins.set(server.identity, {
                    status,
                    session,
                    generation,
                    evidence,
                  });
                  observed.set(server.identity, { state: "unavailable" });
                }),
              ),
            ),
          ).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if (!current()) authority.blocked ??= { kind: "rejected" };
                const mutation = yield* store.mutation(server.identity);
                yield* authProgress(ui, {
                  phase: saved ? "finalizing" : "saving",
                  credentialsSaved: saved,
                  mutation,
                });
              }),
            ),
          );
          if (!current()) return yield* stale();
          return status;
        }).pipe(authority.permit.withPermits(1));
      }),
      false,
    );
  const logout: McpAuthContract["logout"] = (server) =>
    Effect.suspend(() => {
      if (!oauthConfig(server))
        return Effect.fail(
          boundaryError("unsupported", "not-sent", "Only stored OAuth grants support logout."),
        );
      observed.set(server.identity, { state: "required" });
      pendingLogins.delete(server.identity);
      const authority = authorityFor(server.identity);
      authority.generation++;
      authority.blocked = { kind: "logout" };
      challenges.delete(server.identity);
      const previous = authority.revoked;
      authority.revoked = Deferred.makeUnsafe<void>();
      Deferred.doneUnsafe(previous, Effect.void);
      // Revoke first, then join the permit and the store's native mutation fence.
      return store.remove(server.identity).pipe(authority.permit.withPermits(1));
    });
  const status: McpAuthContract["status"] = (server) =>
    Effect.gen(function* () {
      if (disposed || !server.enabled || !server.definition) return { state: "unavailable" };
      if (server.definition.transport === "stdio" || server.definition.auth.type === "none")
        return { state: "none" };
      if (
        server.definition.auth.type === "oauth" &&
        (yield* store.mutation(server.identity)) !== "idle"
      )
        return { state: "unavailable" };
      if (authorityFor(server.identity).blocked) return { state: "required" };
      return observed.get(server.identity) ?? { state: "unchecked" };
    });
  const reject: McpAuthContract["reject"] = (server, evidence) =>
    Effect.sync(() => {
      if (disposed) return;
      const challenge = evidence?.error && getAuthChallenge(evidence.error);
      if (challenge && oauthConfig(server)) challenges.set(server.identity, challenge);
      if (evidence?.credentialUsed && oauthConfig(server))
        authorityFor(server.identity).blocked =
          evidence.error?.reason === "oauth-insufficient-scope"
            ? { kind: "rejected", reason: "oauth-insufficient-scope" }
            : { kind: "rejected" };
      authorityFor(server.identity).evidenceRevision++;
      pendingLogins.delete(server.identity);
      observed.set(server.identity, { state: "required" });
    });
  const finishLogin = (server: McpEffectiveServer, status: McpAuthStatus, succeeded: boolean) =>
    Effect.gen(function* () {
      const mutation = yield* store.mutation(server.identity);
      const receipt = pendingLogins.get(server.identity);
      if (
        !receipt ||
        receipt.status !== status ||
        disposed ||
        receipt.session !== sessionGeneration ||
        receipt.generation !== authorityFor(server.identity).generation ||
        receipt.evidence !== authorityFor(server.identity).evidenceRevision
      )
        return;
      pendingLogins.delete(server.identity);
      observed.set(server.identity, {
        state:
          succeeded && mutation === "idle" && !authorityFor(server.identity).blocked
            ? "ready"
            : "unavailable",
      });
    });
  const completeLogin: McpAuthContract["completeLogin"] = (server, status) =>
    finishLogin(server, status, true);
  const finalizationFailed: McpAuthContract["finalizationFailed"] = (server, status) =>
    finishLogin(server, status, false);
  return {
    access,
    login,
    logout,
    status,
    revoke,
    reject,
    completeLogin,
    finalizationFailed,
  } satisfies McpAuthContract;
});
export class McpAuth extends Context.Service<McpAuth, McpAuthContract>()(
  "pi-mcp/auth/service/McpAuth",
) {
  static readonly layerWithDependencies = Layer.effect(this, makeMcpAuth);
  static readonly layer = (options: KeychainOptions = {}) =>
    this.layerWithDependencies.pipe(
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
