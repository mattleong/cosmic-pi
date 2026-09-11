import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { hasControlCharacter, NetworkAddresses } from "pi-cosmic-core";
import { McpCredentialStore } from "../boundary/credential-store.ts";
import type { KeychainOptions } from "../boundary/keychain.ts";
import { McpSdkAuth } from "../boundary/sdk-auth.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import type { McpEffectiveServer } from "../config/model.ts";
import type { McpAuthContract, McpAuthStatus } from "./model.ts";
import { withAuthFailureReason } from "./diagnostics.ts";
import { authFailure, oauthConfig } from "./policy.ts";
import { authProgress } from "./progress.ts";

interface Authority {
  readonly permit: Semaphore.Semaphore;
  generation: number;
  blocked: boolean;
  revoked: Deferred.Deferred<void>;
}
// Grants can be refreshed by replacement runtimes. Native persistence and refresh share
// this process-wide admission, while each runtime separately revokes its own authority.
const authorities = new Map<string, Authority>();
const authorityFor = (identity: string): Authority => {
  let value = authorities.get(identity);
  if (!value) {
    value = {
      permit: Semaphore.makeUnsafe(1),
      generation: 0,
      blocked: false,
      revoked: Deferred.makeUnsafe<void>(),
    };
    authorities.set(identity, value);
  }
  return value;
};
const stale = () => boundaryError("stale", "not-sent", "OAuth operation was revoked.");
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
  const evidenceRevision = new Map<string, number>();
  const pendingLogins = new Map<
    string,
    {
      readonly status: McpAuthStatus;
      readonly session: number;
      readonly generation: number;
      readonly evidence: number | undefined;
    }
  >();
  const revoke = Effect.sync(() => {
    sessionGeneration++;
    const previous = revoked;
    revoked = Deferred.makeUnsafe<void>();
    observed.clear();
    pendingLogins.clear();
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
      const evidence = evidenceRevision.get(server.identity);
      const current = () =>
        generation === sessionGeneration &&
        !disposed &&
        serverGeneration === authority.generation &&
        evidence === evidenceRevision.get(server.identity);
      const cancelled = Effect.raceFirst(Deferred.await(signal), Deferred.await(serverSignal));
      return Effect.raceFirst(work, cancelled.pipe(Effect.andThen(Effect.fail(stale())))).pipe(
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
        !authorities.get(server.identity)?.blocked;
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
          const current = () =>
            !disposed &&
            sessionGeneration === session &&
            authority.generation === generation &&
            !authority.blocked;
          return yield* Effect.gen(function* () {
            if (!current()) return yield* authFailure();
            let grant = yield* store.read(server.identity);
            if (!current()) return yield* stale();
            if (!grant) return yield* authFailure();
            const now = yield* Clock.currentTimeMillis;
            if (grant.expiresAt !== undefined && grant.expiresAt <= now + 30_000) {
              const refreshed = yield* sdk.refresh(server, grant);
              if (!current()) return yield* stale();
              yield* store.write(server.identity, refreshed).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (!current()) authority.blocked = true;
                  }),
                ),
              );
              if (!current()) return yield* stale();
              grant = refreshed;
            }
            const token = yield* sdk.token(server, grant);
            if (!current()) return yield* stale();
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
        const current = () =>
          !disposed && sessionGeneration === session && authority.generation === generation;
        return yield* Effect.gen(function* () {
          if (!current()) return yield* stale();
          // Probe secure storage before starting a browser or sending registration traffic.
          yield* authProgress(ui, { phase: "storage" });
          yield* store.read(server.identity);
          if (!current()) return yield* stale();
          const grant = yield* sdk.login(server, ui);
          if (!current()) return yield* stale();
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
                    authority.blocked = true;
                    return;
                  }
                  authority.blocked = false;
                  pendingLogins.set(server.identity, {
                    status,
                    session,
                    generation,
                    evidence: evidenceRevision.get(server.identity),
                  });
                  observed.set(server.identity, { state: "unavailable" });
                }),
              ),
            ),
          ).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                if (!current()) authority.blocked = true;
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
      authority.blocked = true;
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
      if (authorities.get(server.identity)?.blocked) return { state: "required" };
      return observed.get(server.identity) ?? { state: "unchecked" };
    });
  const reject: McpAuthContract["reject"] = (server) =>
    Effect.sync(() => {
      if (disposed) return;
      evidenceRevision.set(server.identity, (evidenceRevision.get(server.identity) ?? 0) + 1);
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
        receipt.evidence !== evidenceRevision.get(server.identity)
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
